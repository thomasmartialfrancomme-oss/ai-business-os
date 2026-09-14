import { prisma } from "../db";
import { writeAudit } from "../audit";
import {
  priceCents,
  monthlyEquivalentCents,
  PLANS,
  isBillingInterval,
  isPlanCode,
  type BillingIntervalKey,
  type PlanCode,
} from "../plans";
import type { SessionUser } from "../auth";
import { getGateway } from ".";
import { deliverEvents } from "./events";
import { registerCheckoutIntent, applySubscription } from "./state";

/**
 * Services de facturation appelés par les routes API.
 *
 * Règle de conception : ces fonctions ne décident JAMAIS qu'un paiement est réussi.
 * Elles demandent une action à la passerelle (créer un checkout, changer de prix,
 * annuler…), puis laissent le webhook Stripe écrire l'état en base.
 * En mode simulation uniquement, les événements « que Stripe enverrait » sont
 * livrés immédiatement dans le même pipeline de webhook.
 */

export class BillingError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400
  ) {
    super(message);
    this.name = "BillingError";
  }
}

function originFor(origin: string): string {
  return origin.replace(/\/$/, "");
}

export interface CheckoutResult {
  url: string;
  sessionId: string;
  mode: "live" | "test" | "simulation";
  planCode: PlanCode;
  interval: BillingIntervalKey;
  amountCents: number;
  currency: string;
}

/**
 * Crée une session Stripe Checkout pour un abonnement.
 * Le montant est TOUJOURS recalculé côté serveur depuis le catalogue :
 * un montant envoyé par le navigateur est ignoré.
 */
export async function createSubscriptionCheckout(input: {
  user: SessionUser;
  planCode: string;
  interval: string;
  origin: string;
  promoCode?: string | null;
}): Promise<CheckoutResult> {
  if (!isPlanCode(input.planCode)) throw new BillingError("Forfait inconnu.", "unknown_plan");
  if (!isBillingInterval(input.interval)) throw new BillingError("Périodicité inconnue.", "unknown_interval");

  const planCode = input.planCode;
  const interval = input.interval;
  const amountCents = priceCents(planCode, interval);
  const plan = PLANS[planCode];
  const gateway = getGateway();

  const existing = await prisma.subscription.findUnique({ where: { userId: input.user.id } });

  if (existing && ["ACTIVE", "TRIALING", "PAST_DUE"].includes(existing.status)) {
    throw new BillingError(
      "Vous avez déjà un abonnement en cours. Utilisez « Changer de forfait » depuis votre espace facturation.",
      "already_subscribed",
      409
    );
  }

  const customerId = await gateway.ensureCustomer({
    userId: input.user.id,
    email: input.user.email,
    name: input.user.name,
    existingId: existing?.stripeCustomerId ?? null,
  });

  const origin = originFor(input.origin);
  const outcome = await gateway.createCheckoutSession({
    userId: input.user.id,
    userEmail: input.user.email,
    planCode,
    interval,
    priceId: null, // résolu côté passerelle depuis STRIPE_PRICE_ID_<PLAN>_<INTERVAL>
    amountCents,
    currency: plan.currency,
    successUrl: `${origin}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${origin}/pricing?checkout=canceled&plan=${planCode}&interval=${interval}`,
    customerId,
    idempotencyKey: `checkout_${input.user.id}_${planCode}_${interval}_${Math.floor(Date.now() / 60000)}`,
  });

  // On mémorise le client Stripe et l'intention d'abonnement, SANS aucun droit d'accès :
  // l'écriture passe par le module d'état (seul autorisé à toucher à ces champs).
  await registerCheckoutIntent({
    userId: input.user.id,
    customerId,
    planCode,
    interval,
    amountCents,
    currency: plan.currency,
  });

  await writeAudit({
    actorType: "CUSTOMER",
    actorId: input.user.id,
    action: "checkout.session.created",
    targetType: "user",
    targetId: input.user.id,
    userId: input.user.id,
    metadata: { sessionId: outcome.data.sessionId, planCode, interval, amountCents, mode: gateway.mode },
  });

  // En simulation, aucun événement n'est encore émis : le paiement n'a pas eu lieu.
  await deliverEvents(outcome.events);

  return {
    url: outcome.data.url,
    sessionId: outcome.data.sessionId,
    mode: gateway.mode,
    planCode,
    interval,
    amountCents,
    currency: plan.currency,
  };
}

/** Changement de forfait : immédiat et au prorata pour une montée en gamme,
 *  sans prorata (effet au renouvellement) pour une descente en gamme. */
export async function changePlan(input: {
  user: SessionUser;
  planCode: string;
  interval: string;
  origin: string;
}): Promise<{ mode: string; prorated: boolean; planCode: PlanCode; interval: BillingIntervalKey }> {
  if (!isPlanCode(input.planCode)) throw new BillingError("Forfait inconnu.", "unknown_plan");
  if (!isBillingInterval(input.interval)) throw new BillingError("Périodicité inconnue.", "unknown_interval");

  const subscription = await prisma.subscription.findUnique({ where: { userId: input.user.id } });
  if (!subscription?.stripeSubscriptionId) {
    throw new BillingError("Aucun abonnement actif à modifier.", "no_subscription", 409);
  }
  if (subscription.status !== "ACTIVE" && subscription.status !== "TRIALING" && subscription.status !== "PAST_DUE") {
    throw new BillingError("Cet abonnement n'est pas modifiable dans son état actuel.", "not_modifiable", 409);
  }

  const gateway = getGateway();
  const newAmount = priceCents(input.planCode, input.interval);
  // On compare les équivalents mensuels pour que le passage mensuel -> annuel soit
  // correctement identifié comme une montée en gamme (donc facturé au prorata).
  const newMonthly = monthlyEquivalentCents(input.planCode, input.interval);
  const currentMonthly = monthlyEquivalentCents(subscription.planCode as PlanCode, subscription.interval);
  const prorated = newMonthly > currentMonthly;

  const outcome = await gateway.changeSubscriptionPrice({
    subscriptionId: subscription.stripeSubscriptionId,
    priceId: null,
    planCode: input.planCode,
    interval: input.interval,
    amountCents: newAmount,
    prorate: prorated,
  });

  // Aucune écriture d'état ici : le changement de forfait est appliqué par l'événement
  // customer.subscription.updated (émis par le fournisseur, livré par notre webhook).
  // En mode simulation, cet événement est livré immédiatement par deliverEvents ci-dessous.

  await writeAudit({
    actorType: "CUSTOMER",
    actorId: input.user.id,
    action: "subscription.plan_changed",
    targetType: "subscription",
    targetId: subscription.id,
    userId: input.user.id,
    metadata: {
      from: { planCode: subscription.planCode, amountCents: subscription.amountCents },
      to: { planCode: input.planCode, amountCents: newAmount },
      prorated,
      mode: gateway.mode,
    },
  });

  await deliverEvents(outcome.events);

  return { mode: gateway.mode, prorated, planCode: input.planCode, interval: input.interval };
}

/** Résiliation : programmée à la fin de la période payée (cancel_at_period_end). */
export async function cancelSubscription(input: { user: SessionUser }): Promise<{ cancelAtPeriodEnd: boolean; accessUntil: Date | null }> {
  const subscription = await prisma.subscription.findUnique({ where: { userId: input.user.id } });
  if (!subscription?.stripeSubscriptionId) {
    throw new BillingError("Aucun abonnement à annuler.", "no_subscription", 409);
  }
  if (subscription.status === "CANCELED") {
    return { cancelAtPeriodEnd: false, accessUntil: subscription.currentPeriodEnd };
  }

  const gateway = getGateway();
  const outcome = await gateway.setCancelAtPeriodEnd({
    subscriptionId: subscription.stripeSubscriptionId,
    cancelAtPeriodEnd: true,
  });

  await writeAudit({
    actorType: "CUSTOMER",
    actorId: input.user.id,
    action: "subscription.cancel_requested",
    targetType: "subscription",
    targetId: subscription.id,
    userId: input.user.id,
    metadata: { cancelAtPeriodEnd: true, currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null },
  });

  await deliverEvents(outcome.events);

  // L'état définitif (cancelAtPeriodEnd) arrive par le webhook ; on renvoie l'intention.
  return { cancelAtPeriodEnd: true, accessUntil: subscription.currentPeriodEnd };
}

/** Annulation d'une résiliation (réactivation du renouvellement). */
export async function resumeSubscription(input: { user: SessionUser }): Promise<{ cancelAtPeriodEnd: boolean }> {
  const subscription = await prisma.subscription.findUnique({ where: { userId: input.user.id } });
  if (!subscription?.stripeSubscriptionId) throw new BillingError("Aucun abonnement à réactiver.", "no_subscription", 409);

  const gateway = getGateway();
  const outcome = await gateway.setCancelAtPeriodEnd({
    subscriptionId: subscription.stripeSubscriptionId,
    cancelAtPeriodEnd: false,
  });

  await writeAudit({
    actorType: "CUSTOMER",
    actorId: input.user.id,
    action: "subscription.cancel_reverted",
    targetType: "subscription",
    targetId: subscription.id,
    userId: input.user.id,
  });

  await deliverEvents(outcome.events);
  return { cancelAtPeriodEnd: false };
}

/** Portail de facturation Stripe : moyen de paiement, factures, historique. */
export async function createBillingPortalSession(input: { user: SessionUser; origin: string }): Promise<{ url: string }> {
  const subscription = await prisma.subscription.findUnique({ where: { userId: input.user.id } });
  if (!subscription?.stripeCustomerId) {
    throw new BillingError("Aucun client Stripe associé : effectuez d'abord un abonnement.", "no_customer", 409);
  }

  const gateway = getGateway();
  const outcome = await gateway.createPortalSession({
    customerId: subscription.stripeCustomerId,
    returnUrl: `${originFor(input.origin)}/billing`,
  });

  await writeAudit({
    actorType: "CUSTOMER",
    actorId: input.user.id,
    action: "billing_portal.opened",
    targetType: "subscription",
    targetId: subscription.id,
    userId: input.user.id,
  });

  return { url: outcome.data.url };
}

/**
 * Resynchronisation à la demande : on relit l'abonnement à la source.
 * C'est une lecture de réparation — elle ne peut jamais « activer » un abonnement
 * que le fournisseur ne considère pas actif.
 */
export async function syncSubscriptionFromProvider(input: { user: SessionUser }): Promise<{ status: string; planCode: string }> {
  const subscription = await prisma.subscription.findUnique({ where: { userId: input.user.id } });
  if (!subscription?.stripeSubscriptionId) throw new BillingError("Aucun abonnement à synchroniser.", "no_subscription", 409);

  const gateway = getGateway();
  const remote = await gateway.retrieveSubscription(subscription.stripeSubscriptionId);
  if (!remote) throw new BillingError("Abonnement introuvable chez le fournisseur de paiement.", "not_found", 404);

  await applySubscription({
    userId: input.user.id,
    subscription: remote,
    eventId: `sync_${Date.now()}`,
    eventCreated: new Date(),
  });

  const updated = await prisma.subscription.findUnique({ where: { userId: input.user.id } });
  return { status: updated?.status ?? "UNKNOWN", planCode: updated?.planCode ?? "STARTER" };
}

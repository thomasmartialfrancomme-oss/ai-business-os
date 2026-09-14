import type { BillingInterval as PrismaInterval, InvoiceStatus, Prisma, SubscriptionStatus } from "@prisma/client";
import { prisma } from "../db";
import { intervalFromStripePriceId, planFromStripePriceId, type BillingIntervalKey } from "../plans";
import { writeAudit } from "../audit";
import type {
  NormalizedSubscription,
  StripeChargeObject,
  StripeCheckoutSession,
  StripeEvent,
  StripeInvoiceObject,
  StripePaymentIntentObject,
  StripeSubscriptionObject,
} from "./types";

/**
 * ══════════════════════════════════════════════════════════════════════════════
 *  MACHINE À ÉTATS DES PAIEMENTS — CŒUR DU SYSTÈME
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * RÈGLE ABSOLUE : ce fichier est le SEUL endroit du projet autorisé à écrire
 * l'état d'un paiement ou d'un abonnement. Il n'est appelé que par
 * /api/stripe/webhook, après vérification cryptographique de la signature Stripe.
 *
 * Conséquences :
 *   - le frontend ne peut jamais déclarer « paiement réussi » ;
 *   - une page de succès n'active rien : elle se contente de lire la base ;
 *   - un événement rejoué (webhook répété) est ignoré grâce à l'idempotence ;
 *   - un événement ancien (livraison hors ordre par Stripe) ne peut pas régresser l'état.
 */

const STATUS_MAP: Record<StripeSubscriptionObject["status"], SubscriptionStatus> = {
  incomplete: "INCOMPLETE",
  incomplete_expired: "INCOMPLETE_EXPIRED",
  trialing: "TRIALING",
  active: "ACTIVE",
  past_due: "PAST_DUE",
  canceled: "CANCELED",
  unpaid: "UNPAID",
  paused: "PAUSED",
};

const INTERVAL_MAP: Record<BillingIntervalKey, PrismaInterval> = { MONTH: "MONTH", YEAR: "YEAR" };

export interface ApplyResult {
  handled: boolean;
  note: string;
}

/**
 * Enregistre l'INTENTION d'abonnement au moment de la création du checkout.
 *
 * Cette écriture, comme toutes celles de ce fichier, ne peut jamais accorder d'accès :
 * le statut est INCOMPLETE (ou conserve un statut payant existant) et le champ
 * `lastPaymentStatus` vaut « pending ». Elle sert uniquement à associer le client
 * Stripe à l'utilisateur afin que les webhooks retrouvent le bon compte.
 */
export async function registerCheckoutIntent(input: {
  userId: string;
  customerId: string;
  planCode: string;
  interval: BillingIntervalKey;
  amountCents: number;
  currency: string;
}): Promise<void> {
  const existing = await prisma.subscription.findUnique({ where: { userId: input.userId } });
  const keepStatus = existing && ["ACTIVE", "TRIALING", "PAST_DUE"].includes(existing.status);

  const data = {
    stripeCustomerId: input.customerId,
    planCode: input.planCode,
    interval: INTERVAL_MAP[input.interval],
    status: keepStatus ? existing!.status : ("INCOMPLETE" as SubscriptionStatus),
    amountCents: input.amountCents,
    currency: input.currency,
    lastPaymentStatus: keepStatus ? existing!.lastPaymentStatus : "pending",
  };

  await prisma.subscription.upsert({
    where: { userId: input.userId },
    create: { userId: input.userId, ...data },
    update: data,
  });
}

/** Normalise un abonnement Stripe (objet d'événement) vers notre format interne. */
export function normalizeSubscriptionObject(sub: StripeSubscriptionObject): NormalizedSubscription {
  const item = sub.items?.data?.[0];
  const interval: BillingIntervalKey = item?.price?.recurring?.interval === "year" ? "YEAR" : "MONTH";
  const priceId = item?.price?.id ?? null;

  // Priorité aux métadonnées (posées par notre checkout), repli sur le catalogue de prix.
  const metadata = (sub.metadata ?? {}) as Record<string, string>;
  const planCode = metadata.plan_code ?? planFromStripePriceId(priceId);
  const intervalResolved = (metadata.interval as BillingIntervalKey | undefined) ?? intervalFromStripePriceId(priceId) ?? interval;

  return {
    id: sub.id,
    customerId: typeof sub.customer === "string" ? sub.customer : (sub.customer as { id: string }).id,
    status: sub.status,
    priceId,
    planCode: planCode ?? null,
    interval: intervalResolved,
    amountCents: item?.price?.unit_amount ?? 0,
    currency: item?.price?.currency ?? "eur",
    currentPeriodStart: sub.current_period_start ? new Date(sub.current_period_start * 1000) : null,
    currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
    cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
    endedAt: sub.ended_at ? new Date(sub.ended_at * 1000) : null,
    latestInvoiceId: sub.latest_invoice ?? null,
    metadata,
  };
}

/** Retrouve l'utilisateur propriétaire d'un objet Stripe (métadonnées, puis customer, puis client_reference_id). */
async function resolveUserId(object: Record<string, unknown>): Promise<string | null> {
  const metadata = (object.metadata ?? {}) as Record<string, string>;
  if (metadata.user_id) return metadata.user_id;

  if (typeof object.client_reference_id === "string" && object.client_reference_id) {
    return object.client_reference_id;
  }

  const customerId =
    typeof object.customer === "string" ? object.customer : ((object.customer as { id?: string } | null)?.id ?? null);

  if (customerId) {
    const subscription = await prisma.subscription.findFirst({ where: { stripeCustomerId: customerId } });
    if (subscription) return subscription.userId;
  }

  // Cas d'un paiement par virement ou d'une facture manuelle : on retrouve via l'e-mail client.
  const email = (object.customer_email as string | undefined) ?? (metadata.email as string | undefined);
  if (email) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) return user.id;
  }

  return null;
}

/**
 * Applique un abonnement Stripe à la base.
 * Garde anti-régression : un événement plus ancien que le dernier appliqué est ignoré.
 */
export async function applySubscription(
  input: {
    userId: string;
    subscription: NormalizedSubscription;
    eventId: string;
    eventCreated: Date;
  }
): Promise<{ skipped: "out_of_order" | null }> {
  const { userId, subscription, eventId, eventCreated } = input;

  const existing = await prisma.subscription.findUnique({ where: { userId } });

  if (existing?.lastStripeEventAt && eventCreated < existing.lastStripeEventAt) {
    await writeAudit({
      actorType: "STRIPE",
      action: "stripe.event.out_of_order_ignored",
      targetType: "subscription",
      targetId: existing.id,
      userId,
      metadata: { eventId, eventCreated: eventCreated.toISOString(), lastApplied: existing.lastStripeEventAt.toISOString() },
    });
    return { skipped: "out_of_order" };
  }

  const status = STATUS_MAP[subscription.status];
  const planCode = subscription.planCode ?? existing?.planCode ?? "STARTER";

  const data: Prisma.SubscriptionUncheckedCreateInput = {
    userId,
    stripeCustomerId: subscription.customerId,
    stripeSubscriptionId: subscription.id,
    stripePriceId: subscription.priceId,
    planCode,
    interval: INTERVAL_MAP[subscription.interval],
    status,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    canceledAt: subscription.canceledAt,
    endedAt: subscription.endedAt,
    amountCents: subscription.amountCents || existing?.amountCents || 0,
    currency: subscription.currency,
    lastStripeEventId: eventId,
    lastStripeEventAt: eventCreated,
    // Une réactivation lève l'état de résiliation.
    ...(status === "ACTIVE" && !subscription.cancelAtPeriodEnd ? { pendingPlanCode: null, pendingInterval: null } : {}),
  };

  const saved = await prisma.subscription.upsert({
    where: { userId },
    create: data,
    update: { ...data, userId: undefined },
  });

  await writeAudit({
    actorType: "STRIPE",
    action:
      saved.status !== status
        ? "subscription.status_sync"
        : existing && existing.status !== status
          ? "subscription.status_changed"
          : "subscription.synced",
    targetType: "subscription",
    targetId: saved.id,
    userId,
    metadata: {
      eventId,
      stripeSubscriptionId: subscription.id,
      status,
      previousStatus: existing?.status ?? null,
      planCode,
      interval: subscription.interval,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
    },
  });

  return { skipped: null };
}

/**
 * checkout.session.completed — première confirmation côté Stripe.
 *
 * ⚠️ On n'active RIEN sur la seule base du retour navigateur : cet événement est
 * signé par Stripe. Et même ici, l'activation exige que le fournisseur confirme
 * un statut d'abonnement actif (voir la relecture de l'abonnement ci-dessous).
 */
async function handleCheckoutSessionCompleted(
  session: StripeCheckoutSession,
  event: StripeEvent,
  retrieve: (id: string) => Promise<NormalizedSubscription | null>
): Promise<ApplyResult> {
  const userId = await resolveUserId(session as unknown as Record<string, unknown>);
  if (!userId) {
    return { handled: false, note: `Aucun utilisateur associé à la session ${session.id}` };
  }

  const customerId = session.customer ?? null;

  // Paiement non confirmé (ex. moyen de paiement asynchrone encore en attente) :
  // on enregistre un abonnement INCOMPLETE, sans aucun accès.
  if (session.payment_status !== "paid") {
    const existing = await prisma.subscription.findUnique({ where: { userId } });
    await prisma.subscription.upsert({
      where: { userId },
      create: {
        userId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: session.subscription,
        planCode: session.metadata?.plan_code ?? "STARTER",
        interval: INTERVAL_MAP[(session.metadata?.interval as BillingIntervalKey) ?? "MONTH"],
        status: "INCOMPLETE",
        stripePriceId: null,
        amountCents: session.amount_total ?? 0,
        currency: session.currency ?? "eur",
        lastPaymentStatus: session.payment_status,
        lastStripeEventId: event.id,
        lastStripeEventAt: new Date(event.created * 1000),
      },
      update: {
        stripeCustomerId: customerId,
        stripeSubscriptionId: session.subscription,
        status: existing?.status === "ACTIVE" ? existing.status : "INCOMPLETE",
        lastPaymentStatus: session.payment_status,
        lastStripeEventId: event.id,
        lastStripeEventAt: new Date(event.created * 1000),
      },
    });

    await writeAudit({
      actorType: "STRIPE",
      action: "checkout.session.completed.unpaid",
      targetType: "user",
      targetId: userId,
      userId,
      metadata: { sessionId: session.id, paymentStatus: session.payment_status },
    });

    return { handled: true, note: "Session terminée mais paiement non confirmé : abonnement laissé inactif." };
  }

  // Paiement confirmé par Stripe : on relit l'abonnement À LA SOURCE pour connaître
  // son statut réel (active, incomplete, past_due…). C'est cette valeur qui décide.
  if (session.subscription) {
    const subscription = await retrieve(session.subscription);
    if (!subscription) {
      return { handled: false, note: `Abonnement ${session.subscription} introuvable à la source` };
    }
    await applySubscription({ userId, subscription, eventId: event.id, eventCreated: new Date(event.created * 1000) });
    return {
      handled: true,
      note: `Paiement confirmé. Statut fournisseur : ${subscription.status}.`,
    };
  }

  // Achat sans abonnement (paiement unique) : on journalise seulement.
  await prisma.subscription.upsert({
    where: { userId },
    create: {
      userId,
      stripeCustomerId: customerId,
      planCode: session.metadata?.plan_code ?? "STARTER",
      interval: INTERVAL_MAP[(session.metadata?.interval as BillingIntervalKey) ?? "MONTH"],
      status: "INCOMPLETE",
      stripePriceId: null,
      amountCents: session.amount_total ?? 0,
      currency: session.currency ?? "eur",
      lastPaymentStatus: "paid",
      lastStripeEventId: event.id,
      lastStripeEventAt: new Date(event.created * 1000),
    },
    update: {
      stripeCustomerId: customerId,
      lastPaymentStatus: "paid",
      lastStripeEventId: event.id,
      lastStripeEventAt: new Date(event.created * 1000),
    },
  });

  return { handled: true, note: "Session payée sans abonnement associé (paiement unique)." };
}

/** customer.subscription.created / updated / deleted / paused / resumed */
async function handleSubscriptionEvent(
  sub: StripeSubscriptionObject,
  event: StripeEvent
): Promise<ApplyResult> {
  const userId = await resolveUserId(sub as unknown as Record<string, unknown>);
  if (!userId) return { handled: false, note: `Aucun utilisateur associé à l'abonnement ${sub.id}` };

  const normalized = normalizeSubscriptionObject(sub);
  await applySubscription({ userId, subscription: normalized, eventId: event.id, eventCreated: new Date(event.created * 1000) });

  if (event.type === "customer.subscription.deleted") {
    await writeAudit({
      actorType: "STRIPE",
      action: "subscription.deleted",
      targetType: "subscription",
      targetId: sub.id,
      userId,
      metadata: { endedAt: normalized.endedAt?.toISOString() ?? null, canceledAt: normalized.canceledAt?.toISOString() ?? null },
    });
    return { handled: true, note: "Abonnement résilié : accès révoqué." };
  }

  return {
    handled: true,
    note: `Abonnement ${event.type.split(".").pop()} — statut ${sub.status}, fin de période ${normalized.currentPeriodEnd?.toISOString() ?? "inconnue"}.`,
  };
}

/**
 * invoice.paid / invoice.payment_succeeded
 * Confirmation de paiement d'une facture (première facture ou renouvellement).
 */
async function handleInvoicePaid(invoice: StripeInvoiceObject, event: StripeEvent): Promise<ApplyResult> {
  const userId = await resolveUserId(invoice as unknown as Record<string, unknown>);
  if (!userId) return { handled: false, note: `Aucun utilisateur associé à la facture ${invoice.id}` };

  // Sécurité : une facture "paid" sans montant encaissé n'est pas une confirmation.
  if (invoice.status !== "paid" || invoice.amount_paid <= 0) {
    await writeAudit({
      actorType: "STRIPE",
      action: "invoice.paid_inconsistent_ignored",
      targetType: "invoice",
      targetId: invoice.id,
      userId,
      metadata: { status: invoice.status, amountPaid: invoice.amount_paid },
    });
    return { handled: true, note: "Événement invoice.paid incohérent (montant nul) : ignoré." };
  }

  const subscriptionRow = await prisma.subscription.findUnique({ where: { userId } });
  const planCode =
    (invoice.lines?.data?.[0]?.price?.id ? planFromStripePriceId(invoice.lines.data[0].price.id) : null) ??
    subscriptionRow?.planCode ??
    "STARTER";

  const paidAt = invoice.status_transitions?.paid_at ? new Date(invoice.status_transitions.paid_at * 1000) : new Date(event.created * 1000);

  const invoiceRow = await prisma.invoice.upsert({
    where: { stripeInvoiceId: invoice.id },
    create: {
      userId,
      subscriptionId: subscriptionRow?.id ?? null,
      stripeInvoiceId: invoice.id,
      number: invoice.number,
      status: "PAID",
      paymentMethod: "CARD",
      planCode,
      interval: INTERVAL_MAP[subscriptionRow?.interval ?? "MONTH"],
      amountDue: invoice.amount_due,
      amountPaid: invoice.amount_paid,
      currency: invoice.currency,
      periodStart: new Date(invoice.period_start * 1000),
      periodEnd: new Date(invoice.period_end * 1000),
      hostedInvoiceUrl: invoice.hosted_invoice_url,
      invoicePdfUrl: invoice.invoice_pdf,
      paidAt,
    },
    update: {
      status: "PAID",
      amountDue: invoice.amount_due,
      amountPaid: invoice.amount_paid,
      paidAt,
      number: invoice.number,
      hostedInvoiceUrl: invoice.hosted_invoice_url,
      invoicePdfUrl: invoice.invoice_pdf,
      bankTransferDeclaredAt: null,
    },
  });

  // Trace du paiement (aucune donnée de carte n'est stockée : uniquement l'identifiant Stripe).
  if (invoice.payment_intent) {
    await prisma.payment.upsert({
      where: { stripePaymentIntentId: invoice.payment_intent },
      create: {
        userId,
        invoiceId: invoiceRow.id,
        stripePaymentIntentId: invoice.payment_intent,
        stripeChargeId: invoice.charge,
        amount: invoice.amount_paid,
        currency: invoice.currency,
        status: "SUCCEEDED",
        method: "CARD",
      },
      update: {
        status: "SUCCEEDED",
        amount: invoice.amount_paid,
        stripeChargeId: invoice.charge,
        failureCode: null,
        failureMessage: null,
      },
    });
  }

  // Reprise d'accès après un échec de paiement : une facture payée remet l'abonnement en règle.
  if (subscriptionRow) {
    const periodEnd = new Date(invoice.period_end * 1000);
    const shouldReactivate = ["PAST_DUE", "UNPAID", "INCOMPLETE"].includes(subscriptionRow.status);

    await prisma.subscription.update({
      where: { id: subscriptionRow.id },
      data: {
        lastPaymentStatus: "paid",
        lastPaymentAt: paidAt,
        lastFailureCode: null,
        lastFailureMessage: null,
        lastFailureAt: null,
        ...(shouldReactivate ? { status: "ACTIVE" as SubscriptionStatus } : {}),
        ...(periodEnd > (subscriptionRow.currentPeriodEnd ?? new Date(0)) ? { currentPeriodEnd: periodEnd } : {}),
        ...(invoice.period_start
          ? { currentPeriodStart: new Date(invoice.period_start * 1000) }
          : {}),
      },
    });

    if (shouldReactivate) {
      await writeAudit({
        actorType: "STRIPE",
        action: "subscription.reactivated_after_payment",
        targetType: "subscription",
        targetId: subscriptionRow.id,
        userId,
        metadata: { invoiceId: invoice.id, previousStatus: subscriptionRow.status },
      });
    }
  }

  await writeAudit({
    actorType: "STRIPE",
    action: "invoice.paid",
    targetType: "invoice",
    targetId: invoiceRow.id,
    userId,
    metadata: {
      eventId: event.id,
      stripeInvoiceId: invoice.id,
      amountPaid: invoice.amount_paid,
      billingReason: invoice.billing_reason,
    },
  });

  return { handled: true, note: `Facture ${invoice.number ?? invoice.id} payée (${invoice.amount_paid / 100} ${invoice.currency.toUpperCase()}).` };
}

/** invoice.payment_failed / invoice.payment_action_required */
async function handleInvoicePaymentFailed(invoice: StripeInvoiceObject, event: StripeEvent): Promise<ApplyResult> {
  const userId = await resolveUserId(invoice as unknown as Record<string, unknown>);
  if (!userId) return { handled: false, note: `Aucun utilisateur associé à la facture ${invoice.id}` };

  const subscriptionRow = await prisma.subscription.findUnique({ where: { userId } });
  const failureCode = (invoice as unknown as { last_finalization_error?: { code?: string } }).last_finalization_error?.code ?? "payment_failed";
  const failureMessage =
    (invoice as unknown as { last_finalization_error?: { message?: string } }).last_finalization_error?.message ??
    "Le paiement de cette facture a échoué. Stripe relance automatiquement le moyen de paiement.";

  const invoiceRow = await prisma.invoice.upsert({
    where: { stripeInvoiceId: invoice.id },
    create: {
      userId,
      subscriptionId: subscriptionRow?.id ?? null,
      stripeInvoiceId: invoice.id,
      number: invoice.number,
      status: "OPEN",
      paymentMethod: "CARD",
      planCode: subscriptionRow?.planCode ?? null,
      interval: INTERVAL_MAP[subscriptionRow?.interval ?? "MONTH"],
      amountDue: invoice.amount_due,
      amountPaid: invoice.amount_paid,
      currency: invoice.currency,
      periodStart: new Date(invoice.period_start * 1000),
      periodEnd: new Date(invoice.period_end * 1000),
      hostedInvoiceUrl: invoice.hosted_invoice_url,
      invoicePdfUrl: invoice.invoice_pdf,
    },
    update: {
      status: "OPEN",
      amountDue: invoice.amount_due,
      amountPaid: invoice.amount_paid,
      hostedInvoiceUrl: invoice.hosted_invoice_url,
      invoicePdfUrl: invoice.invoice_pdf,
    },
  });

  if (invoice.payment_intent) {
    await prisma.payment.upsert({
      where: { stripePaymentIntentId: invoice.payment_intent },
      create: {
        userId,
        invoiceId: invoiceRow.id,
        stripePaymentIntentId: invoice.payment_intent,
        amount: invoice.amount_due,
        currency: invoice.currency,
        status: "FAILED",
        method: "CARD",
        failureCode,
        failureMessage,
      },
      update: { status: "FAILED", failureCode, failureMessage },
    });
  }

  if (subscriptionRow) {
    // Passage en past_due UNIQUEMENT pour un client déjà en règle : la période de grâce
    // ne doit jamais servir à ouvrir un premier accès après un paiement refusé.
    // Un abonnement INCOMPLETE (premier paiement échoué) reste donc sans accès.
    const wasPaying = ["ACTIVE", "TRIALING", "PAST_DUE"].includes(subscriptionRow.status);

    await prisma.subscription.update({
      where: { id: subscriptionRow.id },
      data: {
        status: wasPaying ? "PAST_DUE" : subscriptionRow.status,
        lastPaymentStatus: "failed",
        lastFailureCode: failureCode,
        lastFailureMessage: failureMessage,
        lastFailureAt: new Date(event.created * 1000),
      },
    });
  }

  await writeAudit({
    actorType: "STRIPE",
    action: "invoice.payment_failed",
    targetType: "invoice",
    targetId: invoiceRow.id,
    userId,
    metadata: { eventId: event.id, stripeInvoiceId: invoice.id, amountDue: invoice.amount_due, failureCode },
  });

  return { handled: true, note: `Paiement échoué sur la facture ${invoice.number ?? invoice.id} (${failureCode}).` };
}

/** payment_intent.payment_failed — traçabilité du motif de refus (le statut vient des factures). */
async function handlePaymentIntentFailed(intent: StripePaymentIntentObject, event: StripeEvent): Promise<ApplyResult> {
  const userId = await resolveUserId(intent as unknown as Record<string, unknown>);
  if (!userId) return { handled: false, note: `Aucun utilisateur associé au paiement ${intent.id}` };

  const error = intent.last_payment_error;

  await prisma.payment.upsert({
    where: { stripePaymentIntentId: intent.id },
    create: {
      userId,
      stripePaymentIntentId: intent.id,
      amount: intent.amount,
      currency: intent.currency,
      status: "FAILED",
      method: "CARD",
      failureCode: error?.code ?? null,
      failureMessage: error?.message ?? null,
    },
    update: {
      status: "FAILED",
      failureCode: error?.code ?? null,
      failureMessage: error?.message ?? null,
    },
  });

  await writeAudit({
    actorType: "STRIPE",
    action: "payment_intent.failed",
    targetType: "payment",
    targetId: intent.id,
    userId,
    metadata: { eventId: event.id, code: error?.code ?? null, declineCode: error?.decline_code ?? null },
  });

  return { handled: true, note: `Paiement refusé (${error?.code ?? "inconnu"}). Aucun accès accordé.` };
}

/**
 * charge.refunded — remboursement.
 * Le remboursement est une décision humaine : on met à jour la comptabilité sans
 * jamais prolonger ni couper un accès automatiquement (l'administrateur décide).
 */
async function handleChargeRefunded(charge: StripeChargeObject, event: StripeEvent): Promise<ApplyResult> {
  const userId = await resolveUserId(charge as unknown as Record<string, unknown>);
  if (!userId) return { handled: false, note: `Aucun utilisateur associé au paiement ${charge.payment_intent ?? charge.id}` };

  const fullyRefunded = charge.amount_refunded >= charge.amount;

  if (charge.payment_intent) {
    await prisma.payment.update({
      where: { stripePaymentIntentId: charge.payment_intent },
      data: {
        stripeChargeId: charge.id,
        amountRefunded: charge.amount_refunded,
        status: fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED",
      },
    });
  }

  if (charge.invoice) {
    const invoiceRow = await prisma.invoice.findUnique({ where: { stripeInvoiceId: charge.invoice } });
    if (invoiceRow) {
      await prisma.invoice.update({
        where: { id: invoiceRow.id },
        data: {
          amountRefunded: charge.amount_refunded,
          status: fullyRefunded ? "REFUNDED" : "PARTIALLY_REFUNDED",
        },
      });
    }
  }

  await writeAudit({
    actorType: "STRIPE",
    action: fullyRefunded ? "payment.refunded" : "payment.partially_refunded",
    targetType: "charge",
    targetId: charge.id,
    userId,
    metadata: { eventId: event.id, amountRefunded: charge.amount_refunded, amount: charge.amount },
  });

  return { handled: true, note: `Remboursement enregistré (${charge.amount_refunded / 100} ${charge.currency.toUpperCase()}).` };
}

/**
 * Point d'entrée : applique un événement Stripe vérifié à la base de données.
 * Aucune écriture d'état n'existe ailleurs dans le projet.
 */
export async function applyEvent(
  event: StripeEvent<Record<string, unknown>>,
  deps: { retrieveSubscription: (id: string) => Promise<NormalizedSubscription | null> }
): Promise<ApplyResult> {
  const created = new Date(event.created * 1000);

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as unknown as StripeCheckoutSession;
      // Pour un paiement asynchrone encore en attente, l'événement ne confirme rien.
      if (event.type === "checkout.session.async_payment_succeeded") {
        session.payment_status = "paid";
      }
      return handleCheckoutSessionCompleted(session, event, deps.retrieveSubscription);
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed": {
      const sub = event.data.object as unknown as StripeSubscriptionObject;
      if (event.type === "customer.subscription.paused") sub.status = "paused";
      if (event.type === "customer.subscription.resumed") sub.status = "active";
      return handleSubscriptionEvent(sub, event);
    }

    case "invoice.paid":
    case "invoice.payment_succeeded":
      return handleInvoicePaid(event.data.object as unknown as StripeInvoiceObject, event);

    case "invoice.payment_failed":
    case "invoice.payment_action_required":
      return handleInvoicePaymentFailed(event.data.object as unknown as StripeInvoiceObject, event);

    case "payment_intent.payment_failed":
      return handlePaymentIntentFailed(event.data.object as unknown as StripePaymentIntentObject, event);

    case "charge.refunded":
      return handleChargeRefunded(event.data.object as unknown as StripeChargeObject, event);

    default:
      return { handled: false, note: `Type d'événement non traité : ${event.type}` };
  }
}

/** Types d'événements explicitement écoutés (sert à l'endpoint de configuration Stripe). */
export const HANDLED_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "payment_intent.payment_failed",
  "charge.refunded",
] as const;

/** Statuts de facture qui signifient « payée » (utilisé par les écrans de facturation). */
export const PAID_INVOICE_STATUSES: InvoiceStatus[] = ["PAID"];

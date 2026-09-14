import { randomUUID } from "node:crypto";
import { prisma } from "../db";
import { priceCents, type BillingIntervalKey, type PlanCode } from "../plans";
import { buildCharge, buildCheckoutSession, buildEvent, buildInvoice, buildPaymentIntent, buildSubscription } from "./fixtures";
import type {
  AccountStatus,
  CreateCheckoutSessionInput,
  GatewayOutcome,
  NormalizedSubscription,
  PaymentGateway,
  SimulationAction,
  StripeChargeObject,
  StripeCheckoutSession,
  StripeEvent,
  StripeInvoiceObject,
  StripeSubscriptionObject,
} from "./types";

/**
 * Mode SIMULATION — aucun compte Stripe requis.
 *
 * Objectif : pouvoir dérouler et valider l'intégralité du parcours
 * (checkout → paiement → webhook signé → activation → renouvellement → échec → annulation)
 * sans clé Stripe, puis basculer sur Stripe TEST en changeant une variable d'environnement.
 *
 * Ce mode imite fidèlement le comportement de Stripe :
 *  - les objets créés ont les mêmes identifiants et la même forme (cus_…, sub_…, in_…, pi_…, cs_test_…)
 *  - les événements émis sont de vrais événements JSON signés (HMAC) livrés à
 *    /api/stripe/webhook, donc à travers le même chemin de code que la production.
 *
 * ⚠️ Ce mode est inactif dès qu'une clé STRIPE_SECRET_KEY est présente
 * (sauf ALLOW_SIMULATION=true explicite en environnement de test).
 */

const now = () => Math.floor(Date.now() / 1000);
const sid = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

type SimObjectRow = { id: string; type: string; data: Record<string, unknown> };

async function simCreate(type: string, data: Record<string, unknown>, id?: string): Promise<SimObjectRow> {
  const row = await prisma.simObject.create({
    data: { id: id ?? sid(type.slice(0, 6)), type, data: data as never },
  });
  return { id: row.id, type: row.type, data: row.data as Record<string, unknown> };
}

async function simGet<T = Record<string, unknown>>(id: string): Promise<T | null> {
  const row = await prisma.simObject.findUnique({ where: { id } });
  if (!row) return null;
  return row.data as T;
}

async function simUpdate(id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const row = await prisma.simObject.findUnique({ where: { id } });
  if (!row) throw new Error(`Objet simulé introuvable : ${id}`);
  const merged = { ...(row.data as Record<string, unknown>), ...patch };
  await prisma.simObject.update({ where: { id }, data: { data: merged as never } });
  return merged;
}

/** ID de prix déterministe en simulation : price_sim_PRO_MONTH */
export function simPriceId(code: PlanCode, interval: BillingIntervalKey): string {
  return `price_sim_${code}_${interval}`;
}

function normalize(sub: StripeSubscriptionObject): NormalizedSubscription {
  const item = sub.items.data[0];
  const interval: BillingIntervalKey = item?.price.recurring?.interval === "year" ? "YEAR" : "MONTH";
  const planCode = (sub.metadata?.plan_code as PlanCode | undefined) ?? null;
  return {
    id: sub.id,
    customerId: sub.customer,
    status: sub.status,
    priceId: item?.price.id ?? null,
    planCode,
    interval,
    amountCents: item?.price.unit_amount ?? 0,
    currency: item?.price.currency ?? "eur",
    currentPeriodStart: sub.current_period_start ? new Date(sub.current_period_start * 1000) : null,
    currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
    endedAt: sub.ended_at ? new Date(sub.ended_at * 1000) : null,
    latestInvoiceId: sub.latest_invoice,
    metadata: sub.metadata ?? {},
  };
}

export class SimGateway implements PaymentGateway {
  readonly mode = "simulation" as const;

  private async simSub(subscriptionId: string): Promise<StripeSubscriptionObject> {
    const sub = await simGet<StripeSubscriptionObject>(subscriptionId);
    if (!sub) throw new Error(`Abonnement simulé introuvable : ${subscriptionId}`);
    return sub;
  }

  async ensureCustomer(input: { userId: string; email: string; name: string; existingId: string | null }): Promise<string> {
    if (input.existingId) {
      const existing = await simGet(input.existingId);
      if (existing) return input.existingId;
    }
    const customerId = sid("cus");
    await simCreate(
      "customer",
      {
        id: customerId,
        object: "customer",
        email: input.email,
        name: input.name,
        metadata: { user_id: input.userId },
        created: now(),
      },
      customerId
    );
    return customerId;
  }

  async createCheckoutSession(
    input: CreateCheckoutSessionInput
  ): Promise<GatewayOutcome<{ sessionId: string; url: string; customerId: string }>> {
    const events: StripeEvent<Record<string, unknown>>[] = [];

    // 1) Client
    let customerId = input.customerId;
    if (!customerId) {
      customerId = sid("cus");
      await simCreate(
        "customer",
        {
          id: customerId,
          object: "customer",
          email: input.userEmail,
          metadata: { user_id: input.userId },
          created: now(),
        },
        customerId
      );
    }

    // 2) Prix (déjà créés lors de la synchronisation du catalogue)
    const price = simPriceId(input.planCode as PlanCode, input.interval);
    if (!(await simGet(price))) {
      await simCreate(
        "price",
        {
          id: price,
          object: "price",
          unit_amount: priceCents(input.planCode as PlanCode, input.interval),
          currency: input.currency,
          recurring: { interval: input.interval === "YEAR" ? "year" : "month", interval_count: 1 },
          metadata: { plan_code: input.planCode, interval: input.interval },
        },
        price
      );
    }

    // 3) Session Checkout (statut "open" tant que le paiement n'est pas confirmé)
    const sessionId = sid("cs_test");
    await simCreate(
      "checkout_session",
      {
      id: sessionId,
      object: "checkout.session",
      mode: "subscription",
      status: "open",
      payment_status: "unpaid",
      customer: customerId,
      subscription: null,
      payment_intent: null,
      client_reference_id: input.userId,
      amount_total: input.amountCents,
      currency: input.currency,
      created: now(),
      expires_at: now() + 3600,
      metadata: {
        user_id: input.userId,
        plan_code: input.planCode,
        interval: input.interval,
      },
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      },
      sessionId
    );

    // `events` reste vide : aucun abonnement n'existe encore. C'est le paiement
    // (voir simulate({type:"pay_checkout"})) qui déclenchera les événements Stripe.
    return {
      data: { sessionId, url: `/sim/checkout/${sessionId}`, customerId },
      events,
      simulated: true,
    };
  }

  async createPortalSession(input: { customerId: string; returnUrl: string }): Promise<GatewayOutcome<{ url: string }>> {
    // En simulation, le « portail client Stripe » est remplacé par la page /billing elle-même.
    return { data: { url: `${input.returnUrl}?sim_portal=1` }, events: [], simulated: true };
  }

  async retrieveSubscription(subscriptionId: string): Promise<NormalizedSubscription | null> {
    const sub = await simGet<StripeSubscriptionObject>(subscriptionId);
    return sub ? normalize(sub) : null;
  }

  async changeSubscriptionPrice(input: {
    subscriptionId: string;
    priceId: string | null;
    planCode: string;
    interval: BillingIntervalKey;
    amountCents: number;
    prorate: boolean;
  }): Promise<GatewayOutcome<{ subscriptionId: string }>> {
    const sub = await this.simSub(input.subscriptionId);
    const price = simPriceId(input.planCode as PlanCode, input.interval);

    const updated: StripeSubscriptionObject = {
      ...sub,
      items: {
        object: "list",
        data: [
          {
            id: sub.items.data[0]?.id ?? sid("si"),
            price: {
              id: price,
              unit_amount: priceCents(input.planCode as PlanCode, input.interval),
              currency: "eur",
              recurring: { interval: input.interval === "YEAR" ? "year" : "month", interval_count: 1 },
            },
          },
        ],
      },
      metadata: { ...sub.metadata, plan_code: input.planCode, interval: input.interval },
    };
    await simUpdate(sub.id, updated as unknown as Record<string, unknown>);

    // Stripe facture immédiatement la différence (prorata) : on émet l'événement correspondant.
    const events: StripeEvent<Record<string, unknown>>[] = [
      buildEvent("customer.subscription.updated", updated, { livemode: false }) as unknown as StripeEvent<Record<string, unknown>>,
    ];

    if (input.prorate) {
      const diff = input.amountCents - (sub.items.data[0]?.price.unit_amount ?? 0);
      const prorationAmount = Math.max(0, diff);
      const pi = buildPaymentIntent({
        amount: prorationAmount,
        status: "succeeded",
        customer: sub.customer,
        planCode: input.planCode as PlanCode,
        interval: input.interval,
      });
      await simCreate("payment_intent", pi as unknown as Record<string, unknown>, pi.id);
      const invoice = buildInvoice({
        customer: sub.customer,
        subscription: sub.id,
        status: "paid",
        billingReason: "subscription_update",
        planCode: input.planCode as PlanCode,
        interval: input.interval,
        amountCents: prorationAmount,
        periodStart: sub.current_period_start,
        periodEnd: sub.current_period_end,
        paymentIntent: pi.id,
      });
      pi.invoice = invoice.id;
      await simCreate("invoice", invoice as unknown as Record<string, unknown>, invoice.id);
      events.push(
        buildEvent("invoice.paid", invoice, { livemode: false }) as unknown as StripeEvent<Record<string, unknown>>
      );
    }

    return { data: { subscriptionId: sub.id }, events, simulated: true };
  }

  async setCancelAtPeriodEnd(input: {
    subscriptionId: string;
    cancelAtPeriodEnd: boolean;
  }): Promise<GatewayOutcome<{ subscriptionId: string }>> {
    const sub = await this.simSub(input.subscriptionId);
    const updated: StripeSubscriptionObject = {
      ...sub,
      cancel_at_period_end: input.cancelAtPeriodEnd,
      canceled_at: input.cancelAtPeriodEnd ? now() : null,
    };
    await simUpdate(sub.id, updated as unknown as Record<string, unknown>);
    return {
      data: { subscriptionId: sub.id },
      events: [
        buildEvent("customer.subscription.updated", updated, { livemode: false }) as unknown as StripeEvent<Record<string, unknown>>,
      ],
      simulated: true,
    };
  }

  async refund(input: { paymentIntentId: string; amountCents?: number }): Promise<GatewayOutcome<{ refundId: string; amountCents: number }>> {
    const pi = await simGet<{ id: string; amount: number; currency: string; customer: string; invoice: string | null }>(
      input.paymentIntentId
    );
    if (!pi) throw new Error(`Paiement simulé introuvable : ${input.paymentIntentId}`);

    const amount = input.amountCents ?? pi.amount;

    // On retrouve la charge réelle associée à ce paiement (comme le ferait Stripe).
    const chargeRow = await prisma.simObject.findFirst({
      where: { type: "charge", data: { path: ["payment_intent"], equals: input.paymentIntentId } },
    });
    const chargeId = chargeRow?.id ?? `ch_${input.paymentIntentId.replace(/^pi_/, "")}`;
    const charge = (chargeRow?.data ?? null) as StripeChargeObject | null;

    const updatedCharge: StripeChargeObject = buildCharge({
      id: chargeId,
      paymentIntent: input.paymentIntentId,
      invoice: pi.invoice ?? charge?.invoice ?? null,
      customer: pi.customer,
      amount: pi.amount,
      amountRefunded: amount,
      currency: pi.currency,
      status: charge?.status === "failed" ? "failed" : "succeeded",
    });
    if (chargeRow) {
      await simUpdate(chargeId, updatedCharge as unknown as Record<string, unknown>);
    } else {
      await simCreate("charge", updatedCharge as unknown as Record<string, unknown>, chargeId);
    }

    const events: StripeEvent<Record<string, unknown>>[] = [
      buildEvent("charge.refunded", updatedCharge, { livemode: false }) as unknown as StripeEvent<Record<string, unknown>>,
    ];

    if (pi.invoice) {
      const invoice = await simGet<StripeInvoiceObject>(pi.invoice);
      if (invoice) {
        const updatedInvoice: StripeInvoiceObject = {
          ...invoice,
          amount_paid: Math.max(0, invoice.amount_paid - amount),
          status: amount >= invoice.amount_due ? "void" : invoice.status,
        };
        await simUpdate(invoice.id, updatedInvoice as unknown as Record<string, unknown>);
      }
    }

    return { data: { refundId: sid("re"), amountCents: amount }, events, simulated: true };
  }

  async accountStatus(): Promise<AccountStatus> {
    const [payments, refunds] = await Promise.all([
      prisma.payment.findMany({ where: { status: "SUCCEEDED" }, select: { amount: true, currency: true } }),
      prisma.payment.findMany({ where: { amountRefunded: { gt: 0 } }, select: { amountRefunded: true } }),
    ]);
    const gross = payments.reduce((sum, p) => sum + p.amount, 0);
    const refunded = refunds.reduce((sum, p) => sum + p.amountRefunded, 0);

    return {
      mode: "simulation",
      chargesEnabled: true,
      payoutsEnabled: true,
      country: "FR",
      defaultCurrency: "eur",
      availableCents: Math.max(0, gross - refunded),
      pendingCents: 0,
      payoutSchedule: "Quotidien (simulé) — versement automatique sur le compte bancaire configuré",
      bankAccounts: [
        {
          bankName: process.env.BANK_NAME || "Compte bancaire du propriétaire (non configuré)",
          last4: (process.env.BANK_IBAN || "").slice(-4) || null,
          currency: "eur",
          default: true,
        },
      ],
    };
  }

  /**
   * Reproduit ce que Stripe ferait côté serveur (paiement de la session, renouvellement,
   * échec de paiement) puis renvoie les événements à livrer à notre webhook.
   */
  async simulate(action: SimulationAction): Promise<GatewayOutcome<Record<string, unknown>>> {
    switch (action.type) {
      case "pay_checkout":
        return this.payCheckout(action.sessionId, action.outcome);
      case "renew_subscription":
        return this.renewSubscription(action.subscriptionId, action.outcome);
      case "expire_checkout": {
        const session = await simGet<StripeCheckoutSession>(action.sessionId);
        if (!session) throw new Error(`Session introuvable : ${action.sessionId}`);
        await simUpdate(session.id, { status: "expired" });
        return { data: { sessionId: session.id }, events: [], simulated: true };
      }
    }
  }

  private async payCheckout(
    sessionId: string,
    outcome: "success" | "declined" | "insufficient_funds" | "requires_action"
  ): Promise<GatewayOutcome<Record<string, unknown>>> {
    const session = await simGet<StripeCheckoutSession>(sessionId);
    if (!session) throw new Error(`Session de paiement introuvable : ${sessionId}`);
    if (session.status === "complete" && outcome === "success") {
      return { data: { sessionId, alreadyPaid: true }, events: [], simulated: true };
    }
    if (session.status === "expired") throw new Error("Cette session de paiement a expiré.");

    const userId = session.metadata.user_id;
    const planCode = session.metadata.plan_code as PlanCode;
    const interval = (session.metadata.interval as BillingIntervalKey) ?? "MONTH";
    const amount = session.amount_total ?? 0;
    const customer = session.customer!;

    // ---- Échec de paiement -------------------------------------------------
    if (outcome !== "success") {
      const failureCode =
        outcome === "insufficient_funds" ? "card_declined" : outcome === "requires_action" ? "authentication_required" : "card_declined";
      const failureMessage =
        outcome === "insufficient_funds"
          ? "Provision insuffisante sur la carte (insufficient_funds)."
          : outcome === "requires_action"
            ? "Authentification 3D Secure requise (authentication_required)."
            : "Carte refusée par la banque émettrice (generic_decline).";

      const pi = buildPaymentIntent({
        amount,
        status: "requires_payment_method",
        customer,
        failureCode,
        failureMessage,
        planCode,
        interval,
      });
      await simCreate("payment_intent", pi as unknown as Record<string, unknown>, pi.id);

      const invoice = buildInvoice({
        customer,
        subscription: null,
        status: "open",
        billingReason: "subscription_create",
        planCode,
        interval,
        amountCents: amount,
        periodStart: now(),
        periodEnd: now() + (interval === "YEAR" ? 365 * 24 * 3600 : 30 * 24 * 3600),
        paymentIntent: pi.id,
        // Stripe reflète le motif d'échec de la tentative sur la facture ouverte.
        failureCode,
        failureMessage,
      });
      await simCreate("invoice", invoice as unknown as Record<string, unknown>, invoice.id);

      await simUpdate(session.id, { payment_intent: pi.id, status: "open" });

      const events: StripeEvent<Record<string, unknown>>[] = [
        buildEvent("payment_intent.payment_failed", pi) as unknown as StripeEvent<Record<string, unknown>>,
        buildEvent("invoice.payment_failed", invoice) as unknown as StripeEvent<Record<string, unknown>>,
      ];
      return { data: { sessionId, failureCode }, events, simulated: true };
    }

    // ---- Paiement réussi ---------------------------------------------------
    const periodStart = now();
    const periodEnd = periodStart + (interval === "YEAR" ? 365 * 24 * 3600 : 30 * 24 * 3600);

    const subscription = buildSubscription({
      customer,
      status: "active",
      planCode,
      interval,
      priceId: simPriceId(planCode, interval),
      periodStart,
      periodEnd,
    });

    const pi = buildPaymentIntent({ amount, status: "succeeded", customer, planCode, interval });

    const invoice = buildInvoice({
      customer,
      subscription: subscription.id,
      status: "paid",
      billingReason: "subscription_create",
      planCode,
      interval,
      amountCents: amount,
      periodStart,
      periodEnd,
      paymentIntent: pi.id,
    });

    // Chaînage des identifiants : paiement → facture → charge (indispensable pour que
    // l'événement charge.refunded retrouve la facture concernée).
    const charge = buildCharge({ paymentIntent: pi.id, customer, amount, invoice: invoice.id });
    pi.invoice = invoice.id;
    invoice.charge = charge.id;
    subscription.latest_invoice = invoice.id;
    const completedSession = buildCheckoutSession({
      id: session.id,
      customer,
      subscription: subscription.id,
      paymentIntent: pi.id,
      paymentStatus: "paid",
      status: "complete",
      amountTotal: amount,
      currency: session.currency ?? "eur",
      userId,
      planCode,
      interval,
    });

    await simCreate("subscription", subscription as unknown as Record<string, unknown>, subscription.id);
    await simCreate("payment_intent", pi as unknown as Record<string, unknown>, pi.id);
    await simCreate("charge", charge as unknown as Record<string, unknown>, charge.id);
    await simCreate("invoice", invoice as unknown as Record<string, unknown>, invoice.id);
    await simUpdate(session.id, completedSession as unknown as Record<string, unknown>);

    // Ordre identique à celui de Stripe pour un premier abonnement.
    const events: StripeEvent<Record<string, unknown>>[] = [
      buildEvent("checkout.session.completed", completedSession) as unknown as StripeEvent<Record<string, unknown>>,
      buildEvent("customer.subscription.created", subscription) as unknown as StripeEvent<Record<string, unknown>>,
      buildEvent("invoice.paid", invoice) as unknown as StripeEvent<Record<string, unknown>>,
    ];

    return { data: { sessionId, subscriptionId: subscription.id }, events, simulated: true };
  }

  /** Renouvellement (ou échec de renouvellement) à la fin d'une période. */
  private async renewSubscription(
    subscriptionId: string,
    outcome: "success" | "failed"
  ): Promise<GatewayOutcome<Record<string, unknown>>> {
    const sub = await this.simSub(subscriptionId);
    const item = sub.items.data[0];
    const interval: BillingIntervalKey = item?.price.recurring?.interval === "year" ? "YEAR" : "MONTH";
    const periodMs = interval === "YEAR" ? 365 * 24 * 3600 : 30 * 24 * 3600;
    const periodStart = sub.current_period_end || now();
    const periodEnd = periodStart + periodMs;
    const amount = item?.price.unit_amount ?? 0;

    const events: StripeEvent<Record<string, unknown>>[] = [];

    if (outcome === "failed") {
      // Stripe passe l'abonnement en past_due et relance le client pendant plusieurs jours.
      const failedSub: StripeSubscriptionObject = { ...sub, status: "past_due" };
      const pi = buildPaymentIntent({
        amount,
        status: "requires_payment_method",
        customer: sub.customer,
        failureCode: "card_declined",
        failureMessage: "Carte refusée lors du renouvellement (generic_decline).",
        planCode: sub.metadata.plan_code as PlanCode,
        interval,
      });
      await simCreate("payment_intent", pi as unknown as Record<string, unknown>, pi.id);

      const invoice = buildInvoice({
        customer: sub.customer,
        subscription: sub.id,
        status: "open",
        billingReason: "subscription_cycle",
        planCode: (sub.metadata.plan_code as PlanCode) ?? "PRO",
        interval,
        amountCents: amount,
        periodStart,
        periodEnd,
        paymentIntent: pi.id,
        failureCode: "card_declined",
        failureMessage: "Carte refusée lors du renouvellement (generic_decline).",
      });
      await simCreate("invoice", invoice as unknown as Record<string, unknown>, invoice.id);
      await simUpdate(sub.id, { status: "past_due" });

      events.push(
        buildEvent("customer.subscription.updated", failedSub) as unknown as StripeEvent<Record<string, unknown>>,
        buildEvent("payment_intent.payment_failed", pi) as unknown as StripeEvent<Record<string, unknown>>,
        buildEvent("invoice.payment_failed", invoice) as unknown as StripeEvent<Record<string, unknown>>
      );
      return { data: { subscriptionId: sub.id, status: "past_due" }, events, simulated: true };
    }

    const pi = buildPaymentIntent({ amount, status: "succeeded", customer: sub.customer, planCode: sub.metadata.plan_code as PlanCode, interval });

    const invoice = buildInvoice({
      customer: sub.customer,
      subscription: sub.id,
      status: "paid",
      billingReason: "subscription_cycle",
      planCode: (sub.metadata.plan_code as PlanCode) ?? "PRO",
      interval,
      amountCents: amount,
      periodStart,
      periodEnd,
      paymentIntent: pi.id,
    });

    const charge = buildCharge({ paymentIntent: pi.id, customer: sub.customer, amount, invoice: invoice.id });
    pi.invoice = invoice.id;
    invoice.charge = charge.id;

    const renewed: StripeSubscriptionObject = {
      ...sub,
      status: "active",
      current_period_start: periodStart,
      current_period_end: periodEnd,
      latest_invoice: invoice.id,
    };

    await simCreate("payment_intent", pi as unknown as Record<string, unknown>, pi.id);
    await simCreate("charge", charge as unknown as Record<string, unknown>, charge.id);
    await simCreate("invoice", invoice as unknown as Record<string, unknown>, invoice.id);
    await simUpdate(sub.id, renewed as unknown as Record<string, unknown>);

    events.push(
      buildEvent("invoice.paid", invoice) as unknown as StripeEvent<Record<string, unknown>>,
      buildEvent("customer.subscription.updated", renewed) as unknown as StripeEvent<Record<string, unknown>>
    );

    return { data: { subscriptionId: sub.id, status: "active", periodEnd }, events, simulated: true };
  }
}

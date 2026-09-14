import { randomUUID } from "node:crypto";
import { priceCents, type BillingIntervalKey, type PlanCode } from "../plans";
import type {
  StripeChargeObject,
  StripeCheckoutSession,
  StripeEvent,
  StripeInvoiceObject,
  StripePaymentIntentObject,
  StripeSubscriptionObject,
} from "./types";

/**
 * Fabrique d'objets et d'événements Stripe *au format réel*.
 *
 * Utilisée par le mode simulation et par les tests : les mêmes structures que celles
 * envoyées par Stripe transitent donc par le vrai endpoint /api/stripe/webhook,
 * avec une vraie signature HMAC vérifiée par le SDK Stripe.
 */

const now = () => Math.floor(Date.now() / 1000);
const oid = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

export function buildEvent<T>(type: string, object: T, options: { livemode?: boolean; id?: string } = {}): StripeEvent<T> {
  return {
    id: options.id ?? oid("evt"),
    object: "event",
    api_version: "2025-01-01",
    created: now(),
    livemode: options.livemode ?? false,
    type,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object },
  };
}

export function buildSubscription(options: {
  id?: string;
  customer: string;
  status: StripeSubscriptionObject["status"];
  planCode: PlanCode;
  interval: BillingIntervalKey;
  priceId: string;
  periodStart?: number;
  periodEnd?: number;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: number | null;
  endedAt?: number | null;
  latestInvoice?: string | null;
}): StripeSubscriptionObject {
  const periodStart = options.periodStart ?? now();
  const periodEnd =
    options.periodEnd ?? periodStart + (options.interval === "YEAR" ? 365 * 24 * 3600 : 30 * 24 * 3600);

  return {
    id: options.id ?? oid("sub"),
    object: "subscription",
    customer: options.customer,
    status: options.status,
    items: {
      object: "list",
      data: [
        {
          id: oid("si"),
          price: {
            id: options.priceId,
            unit_amount: priceCents(options.planCode, options.interval),
            currency: "eur",
            recurring: { interval: options.interval === "YEAR" ? "year" : "month", interval_count: 1 },
          },
        },
      ],
    },
    current_period_start: periodStart,
    current_period_end: periodEnd,
    cancel_at_period_end: options.cancelAtPeriodEnd ?? false,
    canceled_at: options.canceledAt ?? null,
    ended_at: options.endedAt ?? null,
    start_date: periodStart,
    latest_invoice: options.latestInvoice ?? null,
    default_payment_method: oid("pm"),
    metadata: { plan_code: options.planCode, interval: options.interval },
  };
}

export function buildInvoice(options: {
  id?: string;
  customer: string;
  subscription: string | null;
  status: StripeInvoiceObject["status"];
  billingReason: StripeInvoiceObject["billing_reason"];
  planCode: PlanCode;
  interval: BillingIntervalKey;
  amountCents?: number;
  amountPaid?: number;
  currency?: string;
  periodStart: number;
  periodEnd: number;
  paidAt?: number | null;
  paymentIntent?: string | null;
  charge?: string | null;
  number?: string;
  failureCode?: string | null;
  failureMessage?: string | null;
}): StripeInvoiceObject {
  const amount = options.amountCents ?? priceCents(options.planCode, options.interval);
  const amountPaid = options.amountPaid ?? (options.status === "paid" ? amount : 0);

  return {
    id: options.id ?? oid("in"),
    object: "invoice",
    customer: options.customer,
    subscription: options.subscription,
    number: options.number ?? `AIBOS-${new Date().getFullYear()}-${Math.floor(Math.random() * 900000 + 100000)}`,
    status: options.status,
    billing_reason: options.billingReason,
    amount_due: amount,
    amount_paid: amountPaid,
    amount_remaining: amount - amountPaid,
    currency: options.currency ?? "eur",
    created: options.periodStart,
    period_start: options.periodStart,
    period_end: options.periodEnd,
    status_transitions: {
      paid_at: options.paidAt ?? (options.status === "paid" ? now() : null),
      finalized_at: options.periodStart,
      voided_at: null,
    },
    lines: {
      object: "list",
      data: [
        {
          id: oid("il"),
          description: `Abonnement AI Business OS ${options.planCode} (${options.interval === "YEAR" ? "annuel" : "mensuel"})`,
          amount,
          price: { id: oid("price") },
          period: { start: options.periodStart, end: options.periodEnd },
        },
      ],
    },
    payment_intent: options.paymentIntent ?? null,
    charge: options.charge ?? null,
    last_finalization_error: options.failureCode
      ? { code: options.failureCode, message: options.failureMessage ?? "Le paiement a échoué." }
      : null,
    hosted_invoice_url: `https://invoice.stripe.com/i/${options.id ?? oid("in")}`,
    invoice_pdf: `https://pay.stripe.com/invoice/${options.id ?? oid("in")}/pdf`,
  };
}

export function buildCheckoutSession(options: {
  id?: string;
  customer: string;
  subscription: string | null;
  paymentIntent?: string | null;
  paymentStatus?: StripeCheckoutSession["payment_status"];
  status?: StripeCheckoutSession["status"];
  amountTotal: number;
  currency?: string;
  userId: string;
  planCode: PlanCode;
  interval: BillingIntervalKey;
  url?: string | null;
}): StripeCheckoutSession {
  return {
    id: options.id ?? oid("cs_test"),
    object: "checkout.session",
    mode: "subscription",
    status: options.status ?? "complete",
    payment_status: options.paymentStatus ?? "paid",
    customer: options.customer,
    subscription: options.subscription,
    payment_intent: options.paymentIntent ?? null,
    client_reference_id: options.userId,
    metadata: {
      user_id: options.userId,
      plan_code: options.planCode,
      interval: options.interval,
    },
    amount_total: options.amountTotal,
    currency: options.currency ?? "eur",
    created: now(),
    expires_at: now() + 3600,
    url: options.url ?? null,
  };
}

export function buildCharge(options: {
  id?: string;
  paymentIntent: string;
  invoice?: string | null;
  customer: string;
  amount: number;
  amountRefunded?: number;
  currency?: string;
  status?: StripeChargeObject["status"];
  failureCode?: string | null;
  failureMessage?: string | null;
}): StripeChargeObject {
  return {
    id: options.id ?? oid("ch"),
    object: "charge",
    payment_intent: options.paymentIntent,
    invoice: options.invoice ?? null,
    customer: options.customer,
    amount: options.amount,
    amount_refunded: options.amountRefunded ?? 0,
    currency: options.currency ?? "eur",
    paid: (options.status ?? "succeeded") === "succeeded",
    refunded: (options.amountRefunded ?? 0) > 0,
    status: options.status ?? "succeeded",
    failure_code: options.failureCode ?? null,
    failure_message: options.failureMessage ?? null,
    refunds: { object: "list", data: [] },
  };
}

export function buildPaymentIntent(options: {
  id?: string;
  amount: number;
  currency?: string;
  status: StripePaymentIntentObject["status"];
  customer: string;
  invoice?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  planCode?: PlanCode;
  interval?: BillingIntervalKey;
}): StripePaymentIntentObject {
  return {
    id: options.id ?? oid("pi"),
    object: "payment_intent",
    amount: options.amount,
    amount_received: options.status === "succeeded" ? options.amount : 0,
    currency: options.currency ?? "eur",
    status: options.status,
    customer: options.customer,
    invoice: options.invoice ?? null,
    metadata: {
      ...(options.planCode ? { plan_code: options.planCode } : {}),
      ...(options.interval ? { interval: options.interval } : {}),
    },
    last_payment_error: options.failureCode
      ? { code: options.failureCode, message: options.failureMessage ?? "Carte refusée", decline_code: "generic_decline" }
      : null,
  };
}

export { SIM_TEST_CARDS } from "../sim-cards";

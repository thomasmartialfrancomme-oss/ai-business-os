/**
 * Types du domaine paiement.
 *
 * On ne dépend jamais des types internes du SDK Stripe dans la logique métier :
 * on décrit ici la forme *réelle* des objets Stripe que nous consommons.
 * Avantage : le mode simulation et les tests produisent exactement la même forme
 * que Stripe, et la logique est vérifiable sans réseau ni compte Stripe.
 */

export type BillingIntervalKey = "MONTH" | "YEAR";

export interface StripeEvent<T = Record<string, unknown>> {
  id: string;
  object: "event";
  api_version?: string;
  created: number;
  livemode: boolean;
  type: string;
  pending_webhooks?: number;
  request?: { id: string | null; idempotency_key?: string | null } | null;
  data: {
    object: T;
    previous_attributes?: Record<string, unknown>;
  };
}

export interface StripeCheckoutSession {
  id: string;
  object: "checkout.session";
  mode: "payment" | "setup" | "subscription";
  status: "open" | "complete" | "expired" | null;
  payment_status: "paid" | "unpaid" | "no_payment_required";
  customer: string | null;
  subscription: string | null;
  payment_intent: string | null;
  client_reference_id: string | null;
  metadata: Record<string, string>;
  amount_total: number | null;
  currency: string | null;
  created: number;
  expires_at: number;
  url?: string | null;
}

export interface StripeSubscriptionItem {
  id: string;
  price: {
    id: string;
    unit_amount: number | null;
    currency: string;
    recurring: { interval: "day" | "week" | "month" | "year"; interval_count: number } | null;
  };
}

export interface StripeSubscriptionObject {
  id: string;
  object: "subscription";
  customer: string;
  status:
    | "incomplete"
    | "incomplete_expired"
    | "trialing"
    | "active"
    | "past_due"
    | "canceled"
    | "unpaid"
    | "paused";
  items: { object: "list"; data: StripeSubscriptionItem[] };
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  ended_at: number | null;
  start_date: number;
  latest_invoice: string | null;
  default_payment_method: string | null;
  metadata: Record<string, string>;
}

export interface StripeInvoiceObject {
  id: string;
  object: "invoice";
  customer: string | null;
  subscription: string | null;
  number: string | null;
  status: "draft" | "open" | "paid" | "void" | "uncollectible" | null;
  billing_reason:
    | "subscription_create"
    | "subscription_cycle"
    | "subscription_update"
    | "manual"
    | "upcoming"
    | null;
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  currency: string;
  created: number;
  period_start: number;
  period_end: number;
  status_transitions: { paid_at: number | null; finalized_at: number | null; voided_at: number | null };
  lines: {
    object: "list";
    data: Array<{
      id: string;
      description: string | null;
      amount: number;
      price: { id: string } | null;
      period: { start: number; end: number };
    }>;
  };
  payment_intent: string | null;
  charge: string | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  parent?: unknown;
  /** Motif du dernier échec de paiement (Stripe le fournit sur les factures ouvertes). */
  last_finalization_error?: { code?: string | null; message?: string | null } | null;
}

export interface StripeChargeObject {
  id: string;
  object: "charge";
  payment_intent: string | null;
  invoice: string | null;
  customer: string | null;
  amount: number;
  amount_refunded: number;
  currency: string;
  paid: boolean;
  refunded: boolean;
  status: "succeeded" | "pending" | "failed";
  failure_code: string | null;
  failure_message: string | null;
  refunds?: { object: "list"; data: Array<{ id: string; amount: number; status: string; currency: string }> };
}

export interface StripePaymentIntentObject {
  id: string;
  object: "payment_intent";
  amount: number;
  amount_received: number;
  currency: string;
  status:
    | "requires_payment_method"
    | "requires_confirmation"
    | "requires_action"
    | "processing"
    | "requires_capture"
    | "canceled"
    | "succeeded";
  customer: string | null;
  invoice: string | null;
  metadata: Record<string, string>;
  last_payment_error: {
    code: string | null;
    message: string | null;
    decline_code?: string | null;
  } | null;
}

/** Abonnement normalisé, indépendant de la source (Stripe test/live ou simulation). */
export interface NormalizedSubscription {
  id: string;
  customerId: string;
  status: StripeSubscriptionObject["status"];
  priceId: string | null;
  planCode: string | null;
  interval: BillingIntervalKey;
  amountCents: number;
  currency: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  endedAt: Date | null;
  latestInvoiceId: string | null;
  metadata: Record<string, string>;
}

export interface CreateCheckoutSessionInput {
  userId: string;
  userEmail: string;
  planCode: string;
  interval: BillingIntervalKey;
  /** ID de prix Stripe (price_…) ou null si la simulation génère un prix local. */
  priceId: string | null;
  amountCents: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
  /** ID client Stripe existant, pour réutiliser le même client. */
  customerId: string | null;
  /** Réutilise un client existant plutôt que d'en créer un nouveau à chaque essai. */
  idempotencyKey?: string;
}

export interface AccountStatus {
  mode: "live" | "test" | "simulation";
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  country: string | null;
  defaultCurrency: string | null;
  availableCents: number;
  pendingCents: number;
  payoutSchedule: string | null;
  bankAccounts: Array<{ bankName: string | null; last4: string | null; currency: string | null; default: boolean }>;
}

/**
 * Résultat d'une opération de passerelle.
 *
 * `events` contient les événements Stripe à livrer à NOTRE webhook :
 *  - avec un vrai compte Stripe : toujours vide — c'est Stripe qui livre les événements ;
 *  - en mode simulation : les événements signés qui reproduisent le comportement de Stripe.
 *
 * Grâce à ce champ, les routes API ont exactement la même logique dans les deux cas.
 */
export interface GatewayOutcome<T> {
  data: T;
  events: StripeEvent<Record<string, unknown>>[];
  simulated: boolean;
}

/** Opérations réservées au mode simulation (reproduction d'événements côté Stripe). */
export type SimulationAction =
  | {
      type: "pay_checkout";
      sessionId: string;
      outcome: "success" | "declined" | "insufficient_funds" | "requires_action";
    }
  | { type: "renew_subscription"; subscriptionId: string; outcome: "success" | "failed" }
  | { type: "expire_checkout"; sessionId: string };

/**
 * Passerelle de paiement. Deux implémentations :
 *  - StripeGateway : compte Stripe du propriétaire (clé sk_test_… ou sk_live_…)
 *  - SimGateway    : mode simulation, sans compte Stripe (démo et tests automatisés)
 *
 * IMPORTANT : quelle que soit l'implémentation, AUCUNE donnée de carte ne transite
 * par notre serveur. La saisie de carte se fait chez Stripe (Checkout / portail).
 */
export interface PaymentGateway {
  readonly mode: "live" | "test" | "simulation";

  /**
   * Garantit l'existence d'un client Stripe pour cet utilisateur :
   * on réutilise l'ID existant s'il y en a un, sinon on en crée un côté Stripe.
   * Évite la prolifération de clients à chaque tentative de checkout.
   */
  ensureCustomer(input: { userId: string; email: string; name: string; existingId: string | null }): Promise<string>;

  createCheckoutSession(
    input: CreateCheckoutSessionInput
  ): Promise<GatewayOutcome<{ sessionId: string; url: string; customerId: string }>>;

  /** Session du portail de facturation Stripe (moyen de paiement, factures, annulation). */
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<GatewayOutcome<{ url: string }>>;

  /** Relit un abonnement à la source (jamais depuis le client). */
  retrieveSubscription(subscriptionId: string): Promise<NormalizedSubscription | null>;

  /** Change l'offre d'un abonnement (avec prorata). */
  changeSubscriptionPrice(input: {
    subscriptionId: string;
    priceId: string | null;
    planCode: string;
    interval: BillingIntervalKey;
    amountCents: number;
    prorate: boolean;
  }): Promise<GatewayOutcome<{ subscriptionId: string }>>;

  /** Programme (ou annule) la résiliation à la fin de la période en cours. */
  setCancelAtPeriodEnd(input: {
    subscriptionId: string;
    cancelAtPeriodEnd: boolean;
  }): Promise<GatewayOutcome<{ subscriptionId: string }>>;

  /** Rembourse un paiement (total ou partiel). */
  refund(input: {
    paymentIntentId: string;
    amountCents?: number;
  }): Promise<GatewayOutcome<{ refundId: string; amountCents: number }>>;

  /** Solde disponible + état du compte Stripe (pour le tableau de bord propriétaire). */
  accountStatus(): Promise<AccountStatus>;

  /** Opérations de simulation (absentes avec un vrai compte Stripe). */
  simulate?(action: SimulationAction): Promise<GatewayOutcome<Record<string, unknown>>>;

  /**
   * Enregistre dans Stripe un paiement encaissé hors Stripe (virement bancaire reçu).
   * Facultatif : activé uniquement si l'administrateur le demande, pour conserver
   * une comptabilité identique entre Stripe et l'application. Le virement reste
   * confirmé par une décision humaine — jamais automatiquement.
   */
  recordBankTransferPayment?(input: {
    customerId: string;
    amountCents: number;
    currency: string;
    description: string;
    reference: string;
  }): Promise<{ providerInvoiceId: string | null }>;
}

import Stripe from "stripe";
import { env } from "../env";
import { priceCents, type BillingIntervalKey, type PlanCode } from "../plans";
import type {
  AccountStatus,
  CreateCheckoutSessionInput,
  GatewayOutcome,
  NormalizedSubscription,
  PaymentGateway,
  StripeSubscriptionObject,
} from "./types";

/**
 * Passerelle Stripe — compte Stripe DU PROPRIÉTAIRE DE LA PLATEFORME.
 *
 * Choix d'architecture (exigence explicite) :
 *   ⛔ Aucun compte Stripe Connect (Express/Custom) n'est créé pour les clients.
 *   ✅ Les paiements d'abonnement sont encaissés sur VOTRE compte Stripe.
 *   ✅ Les virements vers votre compte bancaire sont gérés par Stripe
 *      (settings.payouts.schedule côté tableau de bord Stripe), pas par notre code :
 *      nous n'avons ni IBAN ni coordonnées bancaires stockés en base.
 *
 * Sécurité :
 *   - la clé secrète (sk_…) ne vit que dans process.env côté serveur ;
 *   - aucune donnée de carte ne transite par notre serveur : la saisie se fait
 *     dans Stripe Checkout (domaines Stripe) ou dans le portail de facturation ;
 *   - les montants sont TOUJOURS recalculés côté serveur depuis le catalogue (plans.ts),
 *     jamais acceptés depuis la requête du client.
 */
export class StripeGateway implements PaymentGateway {
  readonly mode: "live" | "test";
  private stripe: Stripe;

  constructor(secretKey: string) {
    if (!secretKey.startsWith("sk_")) {
      throw new Error("STRIPE_SECRET_KEY invalide : une clé sk_test_… ou sk_live_… est attendue.");
    }
    this.mode = secretKey.startsWith("sk_live_") ? "live" : "test";
    // apiVersion volontairement omise : on suit la version épinglée sur le compte Stripe
    // (comportement recommandé par Stripe pour éviter les ruptures de schéma).
    this.stripe = new Stripe(secretKey, {
      appInfo: { name: "AI Business OS — module paiement", version: "1.0.0" },
      maxNetworkRetries: 2,
      timeout: 20_000,
    });
  }

  /** Instance SDK brute (utilisée par l'endpoint webhook pour vérifier les signatures). */
  get sdk(): Stripe {
    return this.stripe;
  }

  async ensureCustomer(input: { userId: string; email: string; name: string; existingId: string | null }): Promise<string> {
    if (input.existingId) {
      try {
        const existing = await this.stripe.customers.retrieve(input.existingId);
        if (existing && !existing.deleted) return existing.id;
      } catch {
        // Client supprimé ou inexistant : on en crée un nouveau ci-dessous.
      }
    }

    const customer = await this.stripe.customers.create(
      {
        email: input.email,
        name: input.name,
        metadata: { user_id: input.userId },
      },
      { idempotencyKey: `customer_${input.userId}` }
    );
    return customer.id;
  }

  async createCheckoutSession(
    input: CreateCheckoutSessionInput
  ): Promise<GatewayOutcome<{ sessionId: string; url: string; customerId: string }>> {
    // Le prix provient du catalogue serveur : on préfère l'ID de prix Stripe configuré,
    // sinon on construit le line_item à la volée (price_data) avec le montant serveur.
    const lineItem: Stripe.Checkout.SessionCreateParams.LineItem = input.priceId
      ? { price: input.priceId, quantity: 1 }
      : {
          quantity: 1,
          price_data: {
            currency: input.currency,
            unit_amount: input.amountCents,
            recurring: { interval: input.interval === "YEAR" ? "year" : "month" },
            product_data: {
              name: `AI Business OS — ${input.planCode} (${input.interval === "YEAR" ? "annuel" : "mensuel"})`,
              metadata: { plan_code: input.planCode, interval: input.interval },
            },
          },
        };

    const params: Stripe.Checkout.SessionCreateParams = {
      mode: "subscription",
      line_items: [lineItem],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: input.userId,
      // Traçabilité : ces métadonnées reviennent dans tous les webhooks.
      metadata: { user_id: input.userId, plan_code: input.planCode, interval: input.interval },
      subscription_data: {
        metadata: { user_id: input.userId, plan_code: input.planCode, interval: input.interval },
      },
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      // Wallet + moyens de paiement dynamiques gérés par Stripe (aucune donnée carte chez nous).
      ...(input.customerId ? { customer: input.customerId } : { customer_email: input.userEmail }),
    };

    const session = await this.stripe.checkout.sessions.create(params, {
      idempotencyKey: input.idempotencyKey,
    });

    if (!session.url) throw new Error("Stripe n'a pas renvoyé d'URL de redirection pour la session Checkout.");

    return {
      data: { sessionId: session.id, url: session.url, customerId: input.customerId ?? "" },
      events: [], // Stripe livrera lui-même les événements au webhook
      simulated: false,
    };
  }

  async createPortalSession(input: { customerId: string; returnUrl: string }): Promise<GatewayOutcome<{ url: string }>> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      return_url: input.returnUrl,
      locale: "fr",
    });
    return { data: { url: session.url }, events: [], simulated: false };
  }

  async retrieveSubscription(subscriptionId: string): Promise<NormalizedSubscription | null> {
    const sub = await this.stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["items.data.price"],
    });
    return this.normalizeSubscription(sub);
  }

  normalizeSubscription(sub: Stripe.Subscription): NormalizedSubscription {
    const item = sub.items?.data?.[0];
    const interval: BillingIntervalKey = item?.price?.recurring?.interval === "year" ? "YEAR" : "MONTH";
    // Compatibilité d'API : selon la version, current_period_* est soit sur l'abonnement,
    // soit porté par les items. On lit les deux emplacements.
    const itemAny = item as unknown as { current_period_start?: number; current_period_end?: number } | undefined;
    const subAny = sub as unknown as {
      current_period_start?: number;
      current_period_end?: number;
      status: StripeSubscriptionObject["status"];
    };
    const start = subAny.current_period_start ?? itemAny?.current_period_start ?? null;
    const end = subAny.current_period_end ?? itemAny?.current_period_end ?? null;

    return {
      id: sub.id,
      customerId: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
      status: subAny.status,
      priceId: item?.price?.id ?? null,
      planCode: (sub.metadata?.plan_code as PlanCode | undefined) ?? null,
      interval,
      amountCents: item?.price?.unit_amount ?? 0,
      currency: item?.price?.currency ?? "eur",
      currentPeriodStart: start ? new Date(start * 1000) : null,
      currentPeriodEnd: end ? new Date(end * 1000) : null,
      cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
      canceledAt: sub.canceled_at ? new Date(sub.canceled_at * 1000) : null,
      endedAt: sub.ended_at ? new Date(sub.ended_at * 1000) : null,
      latestInvoiceId: typeof sub.latest_invoice === "string" ? sub.latest_invoice : sub.latest_invoice?.id ?? null,
      metadata: (sub.metadata ?? {}) as Record<string, string>,
    };
  }

  async changeSubscriptionPrice(input: {
    subscriptionId: string;
    priceId: string | null;
    planCode: string;
    interval: BillingIntervalKey;
    amountCents: number;
    prorate: boolean;
  }): Promise<GatewayOutcome<{ subscriptionId: string }>> {
    const sub = await this.stripe.subscriptions.retrieve(input.subscriptionId);
    const item = sub.items.data[0];
    if (!item) throw new Error("Abonnement Stripe sans ligne d'article : aucun changement possible.");

    if (!input.priceId) {
      throw new Error(
        "Aucun ID de prix Stripe configuré pour cette offre. Lancez `npm run stripe:setup` pour créer le catalogue dans votre compte Stripe."
      );
    }

    await this.stripe.subscriptions.update(input.subscriptionId, {
      items: [{ id: item.id, price: input.priceId }],
      // Facture immédiatement la différence au prorata (passage au forfait supérieur).
      proration_behavior: input.prorate ? "always_invoice" : "none",
      metadata: { plan_code: input.planCode, interval: input.interval },
    });

    return { data: { subscriptionId: input.subscriptionId }, events: [], simulated: false };
  }

  async setCancelAtPeriodEnd(input: {
    subscriptionId: string;
    cancelAtPeriodEnd: boolean;
  }): Promise<GatewayOutcome<{ subscriptionId: string }>> {
    await this.stripe.subscriptions.update(input.subscriptionId, {
      cancel_at_period_end: input.cancelAtPeriodEnd,
    });
    return { data: { subscriptionId: input.subscriptionId }, events: [], simulated: false };
  }

  async refund(input: { paymentIntentId: string; amountCents?: number }): Promise<GatewayOutcome<{ refundId: string; amountCents: number }>> {
    const refund = await this.stripe.refunds.create(
      {
        payment_intent: input.paymentIntentId,
        ...(input.amountCents ? { amount: input.amountCents } : {}),
      },
      { idempotencyKey: `refund_${input.paymentIntentId}_${input.amountCents ?? "full"}` }
    );
    return { data: { refundId: refund.id, amountCents: refund.amount }, events: [], simulated: false };
  }

  /**
   * Enregistre un virement encaissé dans la comptabilité Stripe :
   * facture en mode "send_invoice" + paiement hors ligne (paid_out_of_band).
   * Aucun moyen de paiement n'est saisi et aucune carte n'est impliquée.
   */
  async recordBankTransferPayment(input: {
    customerId: string;
    amountCents: number;
    currency: string;
    description: string;
    reference: string;
  }): Promise<{ providerInvoiceId: string | null }> {
    const invoice = await this.stripe.invoices.create({
      customer: input.customerId,
      collection_method: "send_invoice",
      days_until_due: 0,
      description: `${input.description} — réf. ${input.reference}`,
      metadata: { bank_transfer_reference: input.reference, source: "bank_transfer" },
      currency: input.currency,
      auto_advance: false,
    });

    await this.stripe.invoiceItems.create({
      customer: input.customerId,
      invoice: invoice.id,
      amount: input.amountCents,
      currency: input.currency,
      description: input.description,
    });

    const finalized = await this.stripe.invoices.finalizeInvoice(invoice.id);
    await this.stripe.invoices.pay(finalized.id, { paid_out_of_band: true });

    return { providerInvoiceId: finalized.id };
  }

  async accountStatus(): Promise<AccountStatus> {
    // `retrieve(null)` interroge le compte du propriétaire de la clé (le vôtre).
    const account = await this.stripe.accounts.retrieve(null);
    const [balance, bankAccounts] = await Promise.all([
      this.stripe.balance.retrieve(),
      this.stripe.accounts
        .listExternalAccounts(account.id, { object: "bank_account", limit: 10 })
        .catch(() => null),
    ]);

    const currency = account.default_currency ?? "eur";
    const pick = (entries: Array<{ amount: number; currency: string }>) =>
      entries.filter((e) => e.currency === currency).reduce((sum, e) => sum + e.amount, 0);

    return {
      mode: this.mode,
      chargesEnabled: Boolean(account.charges_enabled),
      payoutsEnabled: Boolean(account.payouts_enabled),
      country: account.country ?? null,
      defaultCurrency: account.default_currency ?? null,
      availableCents: pick(balance.available as Array<{ amount: number; currency: string }>),
      pendingCents: pick(balance.pending as Array<{ amount: number; currency: string }>),
      payoutSchedule: account.settings?.payouts?.schedule?.interval ?? null,
      bankAccounts:
        bankAccounts?.data?.map((raw) => {
          const bank = raw as unknown as {
            bank_name?: string | null;
            last4?: string | null;
            currency?: string | null;
            default_for_currency?: boolean;
          };
          return {
            bankName: bank.bank_name ?? null,
            last4: bank.last4 ?? null,
            currency: bank.currency ?? null,
            default: Boolean(bank.default_for_currency),
          };
        }) ?? [],
    };
  }
}

/** Recalcule côté serveur le montant attendu (défense contre toute manipulation client). */
export function expectedAmountCents(planCode: string, interval: BillingIntervalKey): number {
  return priceCents(planCode as PlanCode, interval);
}

export function isStripeConfigured(): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}
/**
 * scripts/stripe-setup.ts — provisionnement du catalogue dans VOTRE compte Stripe.
 *
 * Crée (ou réutilise) les produits et prix des offres, crée l'endpoint de webhook si
 * APP_URL est publique, affiche le secret de signature et les IDs de prix à coller
 * dans .env.
 *
 * Utilisation :
 *   STRIPE_SECRET_KEY=sk_test_… APP_URL=https://votre-domaine npx tsx scripts/stripe-setup.ts
 *   (ou : npm run stripe:setup)
 *
 * Idempotent : les objets sont retrouvés par métadonnée `aibos_code`/`aibos_interval`,
 * donc relancer le script ne crée pas de doublons.
 *
 * ⚠️ Aucun compte Stripe Connect n'est créé : les paiements sont encaissés sur le
 * compte Stripe propriétaire du script (le vôtre).
 */
import "dotenv/config";
import Stripe from "stripe";
import { BILLING_INTERVALS, PLANS, PLAN_CODES, priceCents, type BillingIntervalKey, type PlanCode } from "../src/lib/plans";

const secretKey = process.env.STRIPE_SECRET_KEY ?? "";

if (!secretKey.startsWith("sk_")) {
  console.error(
    [
      "✗ STRIPE_SECRET_KEY absente ou invalide.",
      "",
      "  1. Créez un compte Stripe (ou connectez-vous) et activez le mode TEST.",
      "  2. Récupérez la clé secrète : https://dashboard.stripe.com/test/apikeys",
      "  3. Relancez :",
      "     STRIPE_SECRET_KEY=sk_test_xxx APP_URL=http://localhost:3000 npm run stripe:setup",
    ].join("\n")
  );
  process.exit(1);
}

const stripe = new Stripe(secretKey, { appInfo: { name: "AI Business OS — setup", version: "1.0.0" } });

interface Provisioned {
  code: PlanCode;
  interval: BillingIntervalKey;
  productId: string;
  priceId: string;
  amount: number;
  currency: string;
}

async function findOrCreateProduct(code: PlanCode): Promise<Stripe.Product> {
  const existing = await stripe.products.search({ query: `metadata['aibos_code']:'${code}'`, limit: 1 });
  if (existing.data[0]) return existing.data[0];

  return stripe.products.create({
    name: `AI Business OS — ${PLANS[code].name}`,
    description: PLANS[code].tagline,
    metadata: { aibos_code: code, aibos_platform: "ai-business-os" },
  });
}

async function findOrCreatePrice(
  product: Stripe.Product,
  code: PlanCode,
  interval: BillingIntervalKey
): Promise<Stripe.Price> {
  const amount = priceCents(code, interval);
  const currency = PLANS[code].currency;
  const stripeInterval = interval === "YEAR" ? "year" : "month";

  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const match = prices.data.find(
    (price) =>
      price.unit_amount === amount &&
      price.currency === currency &&
      price.recurring?.interval === stripeInterval &&
      price.metadata?.aibos_interval === interval
  );
  if (match) return match;

  return stripe.prices.create({
    product: product.id,
    unit_amount: amount,
    currency,
    recurring: { interval: stripeInterval, interval_count: 1 },
    metadata: { aibos_code: code, aibos_interval: interval },
    nickname: `${PLANS[code].name} — ${interval === "YEAR" ? "annuel" : "mensuel"}`,
  });
}

async function ensureWebhookEndpoint(): Promise<{ url: string; secret: string | null } | null> {
  const appUrl = process.env.APP_URL ?? "";
  if (!appUrl.startsWith("https://")) return null;

  const endpointUrl = `${appUrl.replace(/\/$/, "")}/api/stripe/webhook`;
  const events: Stripe.WebhookEndpointUpdateParams.EnabledEvent[] = [
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "invoice.paid",
    "invoice.payment_succeeded",
    "invoice.payment_failed",
    "invoice.payment_action_required",
    "payment_intent.payment_failed",
    "charge.refunded",
  ];

  const existing = await stripe.webhookEndpoints.list({ limit: 100 });
  const found = existing.data.find((endpoint) => endpoint.url === endpointUrl);
  if (found) {
    await stripe.webhookEndpoints.update(found.id, { enabled_events: events, disabled: false });
    return { url: endpointUrl, secret: null }; // le secret n'est visible qu'à la création
  }

  const created = await stripe.webhookEndpoints.create({
    url: endpointUrl,
    enabled_events: events,
    description: "AI Business OS — abonnements, factures, remboursements",
  });
  return { url: endpointUrl, secret: created.secret ?? null };
}

async function ensureBillingPortal(): Promise<string | null> {
  try {
    const configuration = await stripe.billingPortal.configurations.create({
      business_profile: { headline: "AI Business OS — gestion de votre abonnement" },
      features: {
        customer_update: { enabled: true, allowed_updates: ["email", "address", "tax_id"] },
        invoice_history: { enabled: true },
        payment_method_update: { enabled: true },
        subscription_cancel: { enabled: true, mode: "at_period_end" },
      },
    });
    return configuration.id;
  } catch (error) {
    return error instanceof Error ? `échec configuration portail : ${error.message}` : null;
  }
}

async function main() {
  console.log(`\n══ Provisionnement du catalogue — mode ${secretKey.startsWith("sk_live_") ? "LIVE" : "TEST"} ══\n`);

  const account = await stripe.accounts.retrieve(null);
  console.log(`Compte Stripe : ${account.id} (${account.country ?? "?"}) — encaissement ${account.charges_enabled ? "actif" : "inactif"}, virements ${account.payouts_enabled ? "actifs" : "inactifs"}`);
  if (!account.payouts_enabled) {
    console.log("⚠️  Virements désactivés : renseignez le compte bancaire de versement dans le tableau de bord Stripe (Paramètres → Virements).");
  }

  const provisioned: Provisioned[] = [];
  for (const code of PLAN_CODES) {
    const product = await findOrCreateProduct(code);
    for (const interval of BILLING_INTERVALS) {
      const price = await findOrCreatePrice(product, code, interval);
      provisioned.push({
        code,
        interval,
        productId: product.id,
        priceId: price.id,
        amount: price.unit_amount ?? 0,
        currency: price.currency,
      });
      console.log(`  • ${code} ${interval} → ${price.id} (${((price.unit_amount ?? 0) / 100).toFixed(2)} ${price.currency.toUpperCase()})`);
    }
  }

  const webhook = await ensureWebhookEndpoint();
  if (webhook) {
    console.log(`\nEndpoint de webhook : ${webhook.url}`);
    if (webhook.secret) console.log(`Nouveau secret de signature : ${webhook.secret}`);
    else console.log("Endpoint déjà existant : conservez le secret déjà enregistré (ou recréez-le dans le tableau de bord).");
  } else {
    console.log("\nAPP_URL n'est pas une URL HTTPS publique : endpoint de webhook non créé.");
    console.log("Pour le développement local, utilisez : stripe listen --forward-to localhost:3000/api/stripe/webhook");
  }

  const portalId = await ensureBillingPortal();
  console.log(`Portail de facturation : ${portalId ?? "configuration par défaut"}`);

  console.log("\n══ À coller dans .env ══\n");
  for (const item of provisioned) {
    console.log(`STRIPE_PRICE_ID_${item.code}_${item.interval}="${item.priceId}"`);
  }
  if (webhook?.secret) console.log(`STRIPE_WEBHOOK_SECRET="${webhook.secret}"`);

  console.log("\nRappel : les fonds sont encaissés sur CE compte Stripe, puis versés automatiquement");
  console.log("sur le compte bancaire que vous avez configuré dans Stripe. Aucun compte Connect n'est créé.\n");
}

main().catch((error) => {
  console.error("Échec du provisionnement :", error instanceof Error ? error.message : error);
  process.exit(1);
});

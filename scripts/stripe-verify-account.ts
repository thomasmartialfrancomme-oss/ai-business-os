/**
 * scripts/stripe-verify-account.ts — contrôle avant mise en production.
 *
 * Vérifie que le compte Stripe du propriétaire est prêt à encaisser et à verser :
 * encaissement activé, virements activés, compte bancaire de versement présent,
 * catalogue de prix configuré, endpoint de webhook déclaré.
 *
 * Utilisation : npm run stripe:verify-account
 */
import "dotenv/config";
import Stripe from "stripe";
import { BILLING_INTERVALS, PLAN_CODES, priceCents, stripePriceEnvKey } from "../src/lib/plans";

const secretKey = process.env.STRIPE_SECRET_KEY ?? "";

if (!secretKey.startsWith("sk_")) {
  console.error("✗ STRIPE_SECRET_KEY non configurée : impossible de vérifier le compte.");
  process.exit(1);
}

const stripe = new Stripe(secretKey);
const checks: Array<{ label: string; ok: boolean; detail: string }> = [];

function check(label: string, ok: boolean, detail: string) {
  checks.push({ label, ok, detail });
}

async function main() {
  const mode = secretKey.startsWith("sk_live_") ? "LIVE" : "TEST";
  const account = await stripe.accounts.retrieve(null);
  const balance = await stripe.balance.retrieve();

  check("Mode de la clé", true, mode);
  check("Encaissement activé", Boolean(account.charges_enabled), account.charges_enabled ? "ok" : "à activer dans Stripe");
  check("Virements activés", Boolean(account.payouts_enabled), account.payouts_enabled ? "ok" : "compte bancaire/IBAN à renseigner dans Stripe");

  let bankAccounts: Stripe.BankAccount[] = [];
  try {
    const list = await stripe.accounts.listExternalAccounts(account.id, { object: "bank_account", limit: 10 });
    bankAccounts = list.data as Stripe.BankAccount[];
  } catch {
    // Certains comptes n'autorisent pas cette lecture : le tableau de bord reste la référence.
  }
  check(
    "Compte bancaire de versement",
    bankAccounts.length > 0,
    bankAccounts.length > 0
      ? bankAccounts.map((bank) => `${bank.bank_name ?? "banque"} ••••${bank.last4 ?? "????"} (${bank.currency?.toUpperCase()})`).join(", ")
      : "à vérifier dans Stripe → Paramètres → Virements"
  );

  const intervalDefault = balance.available.find((entry) => entry.currency === (account.default_currency ?? "eur"));
  check(
    "Solde disponible",
    true,
    `${((intervalDefault?.amount ?? 0) / 100).toFixed(2)} ${(account.default_currency ?? "eur").toUpperCase()}`
  );

  for (const code of PLAN_CODES) {
    for (const interval of BILLING_INTERVALS) {
      const envKey = stripePriceEnvKey(code, interval);
      const priceId = process.env[envKey] ?? "";
      let detail = "variable d'environnement absente → lancez npm run stripe:setup";
      let ok = false;
      if (priceId.startsWith("price_")) {
        try {
          const price = await stripe.prices.retrieve(priceId);
          const expected = priceCents(code, interval);
          ok = price.unit_amount === expected && price.active;
          detail = ok
            ? `${priceId} — ${((price.unit_amount ?? 0) / 100).toFixed(2)} ${price.currency.toUpperCase()}${price.livemode === (mode === "LIVE") ? "" : " ⚠️ environnement différent de la clé"}`
            : `${priceId} — montant ${((price.unit_amount ?? 0) / 100).toFixed(2)} attendu ${(expected / 100).toFixed(2)}`;
        } catch {
          detail = `${priceId} introuvable sur ce compte`;
        }
      }
      check(`Prix ${code} ${interval}`, ok, detail);
    }
  }

  const appUrl = process.env.APP_URL ?? "";
  if (appUrl.startsWith("https://")) {
    const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
    const match = endpoints.data.find((endpoint) => endpoint.url === `${appUrl.replace(/\/$/, "")}/api/stripe/webhook`);
    check("Endpoint de webhook", Boolean(match), match ? `${match.url} — statut ${match.status}` : "non déclaré dans Stripe");
    check("Secret de signature", Boolean(process.env.STRIPE_WEBHOOK_SECRET), process.env.STRIPE_WEBHOOK_SECRET ? "configuré" : "STRIPE_WEBHOOK_SECRET manquant");
  } else {
    check("Endpoint de webhook", false, "APP_URL doit être une URL HTTPS publique en production");
  }

  console.log("\n══ Contrôle du compte Stripe ══\n");
  for (const item of checks) {
    console.log(`${item.ok ? "✓" : "✗"} ${item.label.padEnd(28)} ${item.detail}`);
  }

  const failures = checks.filter((item) => !item.ok);
  console.log(`\n${checks.length - failures.length}/${checks.length} contrôles réussis.`);
  if (failures.length > 0) {
    console.log("Corrigez les points marqués ✗ avant de passer en production.");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Échec de la vérification :", error instanceof Error ? error.message : error);
  process.exit(1);
});

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { app, createUser, deliverEvent, resetDatabase } from "./helpers";

/**
 * ══════════════════════════════════════════════════════════════════════════════
 *  TESTS DE SÉCURITÉ — vérifient les règles structurantes du module
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Certaines règles ne se testent pas par un appel de fonction mais par une
 * vérification d'architecture (analyse du code source) : elles empêchent qu'une
 * future modification contourne le modèle de sécurité.
 */

const ROOT = join(__dirname, "..");

function walk(dir: string, extensions = [".ts", ".tsx"]): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (["node_modules", ".next", ".git"].includes(entry)) continue;
      results.push(...walk(full, extensions));
    } else if (extensions.some((extension) => entry.endsWith(extension))) {
      results.push(full);
    }
  }
  return results;
}

describe("Sécurité — vérifications d'architecture", () => {
  test("aucun champ de carte bancaire (PAN, CVV, piste) dans le schéma de base", () => {
    // On ignore les commentaires : seuls les champs déclarés nous intéressent.
    const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("///"))
      .join("\n")
      .toLowerCase();

    const forbidden = ["card_number", "card_number", "cardnumber", "cvv", "cvc", "security_code", "card_expiry", "expiry_month", "expiry_year", "track_data", "pan_number"];
    for (const pattern of forbidden) {
      assert.equal(schema.includes(pattern), false, `le schéma ne doit jamais contenir « ${pattern} »`);
    }
    assert.ok(schema.includes("stripe_customer_id"), "l'identifiant client Stripe est bien stocké (identifiant opaque)");
  });

  test("aucun code source n'enregistre de numéro de carte ou de CVV", () => {
    const files = walk(join(ROOT, "src")).concat(walk(join(ROOT, "prisma")));
    // On cible les AFFECTATIONS et DÉCLARATIONS de champs de carte (pas la prose
    // documentaire qui explique, elle, que ces données ne sont jamais stockées).
    const forbidden = [
      /card_?number\s*[:=]/i,
      /\bcvv\s*[:=]/i,
      /\bcvc\s*[:=]/i,
      /security_?code\s*[:=]/i,
      /(expiry|expiration)_?(month|year)\s*[:=]/i,
      /track_?data\s*[:=]/i,
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(content)) offenders.push(`${file.replace(ROOT, "")} → ${pattern}`);
      }
    }
    assert.deepEqual(offenders, [], "aucune donnée de carte ne doit apparaître dans le code");
  });

  test("les composants clients n'importent jamais la configuration serveur ni la base", () => {
    const files = walk(join(ROOT, "src")).filter((file) => file.endsWith(".tsx") || file.endsWith(".ts"));
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const isClient = content.includes('"use client"') || content.includes("'use client'");
      if (!isClient) continue;
      if (content.includes("@/lib/env") || content.includes("@/lib/db") || content.includes("@/lib/payments/state")) {
        offenders.push(file.replace(ROOT, ""));
      }
    }
    assert.deepEqual(offenders, [], "un composant client ne doit pas atteindre la base ni les clés serveur");
  });

  test("seuls les modules de paiement écrivent l'état d'un abonnement", () => {
    const files = walk(join(ROOT, "src")).concat(walk(join(ROOT, "prisma")));
    const allowed = ["src/lib/payments/state.ts", "src/lib/payments/bank-transfer.ts", "prisma/seed.ts"];
    const offenders: string[] = [];
    for (const file of files) {
      const relative = file.replace(ROOT, "");
      if (allowed.some((entry) => relative.endsWith(entry))) continue;
      const content = readFileSync(file, "utf8");
      if (/prisma\.subscription\.(update|upsert|create)/.test(content)) offenders.push(relative);
    }
    assert.deepEqual(
      offenders,
      [],
      "les routes et composants ne doivent pas écrire l'état d'abonnement : seul le pipeline de webhooks le fait"
    );
  });

  test("aucun composant d'interface ne peut déclarer un paiement réussi", () => {
    const files = walk(join(ROOT, "src/components")).concat(walk(join(ROOT, "src/app")));
    const forbidden = ["status: \"ACTIVE\"", "payment_status: \"paid\"", "payment_status: 'paid'", "status: 'ACTIVE'"];
    const offenders: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        if (content.includes(pattern)) offenders.push(`${file.replace(ROOT, "")} → ${pattern}`);
      }
    }
    assert.deepEqual(offenders, [], "le frontend ne doit jamais pouvoir écrire un état « payé »");
  });

  test("la route de statut d'abonnement est strictement en lecture seule", () => {
    const content = readFileSync(join(ROOT, "src/app/api/billing/subscription/status/route.ts"), "utf8");
    assert.ok(content.includes("export async function GET"));
    assert.equal(/export async function (POST|PUT|PATCH|DELETE)/.test(content), false, "aucune écriture possible");
    for (const forbidden of ["prisma.subscription.update", "prisma.subscription.upsert", "prisma.subscription.create", "prisma.invoice.update", "prisma.payment.update"]) {
      assert.equal(content.includes(forbidden), false, `la route de statut ne peut pas écrire (${forbidden})`);
    }
  });

  test("les clés Stripe ne sont lues que via la configuration serveur", () => {
    const files = walk(join(ROOT, "src"));
    const offenders: string[] = [];
    for (const file of files) {
      const relative = file.replace(ROOT, "");
      if (relative.includes("src/lib/env.ts") || relative.includes("src/lib/payments/stripe-gateway.ts")) continue;
      const content = readFileSync(file, "utf8");
      if (/process\.env\.STRIPE_SECRET_KEY|process\.env\.STRIPE_WEBHOOK_SECRET/.test(content)) offenders.push(relative);
    }
    assert.deepEqual(offenders, [], "les clés secrètes ne doivent être lues qu'au centre de configuration");
  });
});

describe("Sécurité — comportements à l'exécution", () => {
  test("rejette une requête de webhook sans en-tête de signature", async () => {
    await resetDatabase();
    const { webhook } = await app();
    const result = await webhook.processWebhook(JSON.stringify({ id: "evt_sans_signature" }), null);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, "signature_missing");
  });

  test("rejette un événement d'un autre environnement (livemode incohérent)", async () => {
    await resetDatabase();
    const { prisma, fixtures } = await app();
    await createUser("mode@test.fr");

    const event = fixtures.buildEvent("customer.subscription.created", { id: "sub_x", object: "subscription" }, { livemode: true });
    const result = await deliverEvent(event);

    assert.equal(result.status, 400);
    assert.equal(result.body.error, "mode_mismatch");
    assert.equal(await prisma.webhookEvent.count(), 0, "l'événement n'est pas enregistré");
  });

  test("une tentative de forcer un paiement via le corps de la requête est sans effet", async () => {
    const { prisma, service } = await app();
    await resetDatabase();
    const user = await createUser("forcer@test.fr");

    // Un client malveillant tente d'imposer son prix et son statut.
    const forged = {
      user,
      planCode: "PRO",
      interval: "MONTH",
      origin: "http://localhost:3000",
      amountCents: 1, // ignoré : recalculé côté serveur
      status: "ACTIVE", // ignoré : jamais lu depuis l'entrée cliente
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const checkout = await service.createSubscriptionCheckout(forged);
    assert.equal(checkout.amountCents, 5900, "le montant provient du catalogue serveur");

    const subscription = await prisma.subscription.findUnique({ where: { userId: user.id } });
    assert.equal(subscription!.status, "INCOMPLETE", "le statut envoyé par le client est ignoré");
    assert.equal(subscription!.amountCents, 5900);
  });

  test("une clé Stripe LIVE est refusée hors production (garde-fou)", () => {
    let failed = false;
    try {
      execFileSync(
        process.execPath,
        ["--import", "tsx", "-e", "import('./src/lib/env.ts').then(() => console.log('chargé'))"],
        {
          cwd: ROOT,
          env: {
            ...process.env,
            NODE_ENV: "development",
            STRIPE_SECRET_KEY: "sk_live_cle_de_test_pour_verifier_le_garde_fou",
            APP_SECRET: "x".repeat(32),
            DATABASE_URL: process.env.DATABASE_URL!,
          },
          stdio: "pipe",
        }
      );
    } catch (error) {
      failed = true;
      const stderr = String((error as { stderr?: Buffer }).stderr ?? "");
      assert.match(stderr, /LIVE/i, "le message d'erreur doit expliquer le refus");
    }
    assert.equal(failed, true, "une clé live en développement doit faire échouer le démarrage");
  });
});

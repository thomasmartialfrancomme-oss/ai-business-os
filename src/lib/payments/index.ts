import { randomBytes } from "node:crypto";
import { prisma } from "../db";
import { env } from "../env";
import { SimGateway } from "./sim-gateway";
import { StripeGateway } from "./stripe-gateway";
import type { PaymentGateway } from "./types";

/**
 * Sélection de la passerelle de paiement, en fonction de la configuration serveur :
 *
 *   STRIPE_SECRET_KEY=sk_test_…  -> StripeGateway (mode "test")       : environnement Stripe TEST
 *   STRIPE_SECRET_KEY=sk_live_…  -> StripeGateway (mode "live")       : encaissement réel
 *   (aucune clé)                 -> SimGateway    (mode "simulation") : démo et tests hors ligne
 *
 * Les routes ne connaissent que l'interface PaymentGateway : aucune ligne de logique
 * métier ne change entre simulation, test et production.
 */

let cached: PaymentGateway | null = null;

export function getGateway(): PaymentGateway {
  if (cached) return cached;

  if (env.stripeMode === "simulation") {
    cached = new SimGateway();
  } else {
    if (!env.simulationAllowed && !env.STRIPE_SECRET_KEY) {
      throw new Error("Aucune passerelle de paiement disponible.");
    }
    cached = new StripeGateway(env.STRIPE_SECRET_KEY);
  }
  return cached;
}

/** Réinitialise le cache (utilisé par les tests qui changent de mode). */
export function resetGatewayCache(): void {
  cached = null;
}

const SIM_SECRET_KEY = "sim_webhook_secret";

/**
 * Secret de signature des webhooks.
 *  - Avec Stripe : STRIPE_WEBHOOK_SECRET (whsec_…), fourni par Stripe CLI ou le tableau de bord.
 *  - En simulation : un secret généré localement et stocké en base (les webhooks sont
 *    signés avec exactement le même algorithme HMAC-SHA256 que Stripe).
 *
 * Ce secret est la SEULE chose qui permet de considérer un webhook comme authentique :
 * sans lui, aucun événement n'est traité.
 */
export async function getWebhookSecret(): Promise<string | null> {
  if (env.STRIPE_WEBHOOK_SECRET) return env.STRIPE_WEBHOOK_SECRET;
  if (env.stripeMode !== "simulation") return null;

  const existing = await prisma.platformSetting.findUnique({ where: { key: SIM_SECRET_KEY } });
  if (existing) {
    const value = existing.value as { secret?: string };
    if (value.secret) return value.secret;
  }

  const secret = `whsec_sim_${randomBytes(24).toString("hex")}`;
  await prisma.platformSetting.upsert({
    where: { key: SIM_SECRET_KEY },
    create: { key: SIM_SECRET_KEY, value: { secret } },
    update: { value: { secret } },
  });
  return secret;
}

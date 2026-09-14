import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Signature des webhooks Stripe.
 *
 * Stripe signe chaque webhook avec l'en-tête `Stripe-Signature` :
 *     t=<timestamp>,v1=<hmac_sha256(secret, "<timestamp>.<payload brut>")>
 *
 * `signPayload` reproduit exactement cet algorithme. Il sert :
 *   1. au mode simulation, pour émettre de VRAIS webhooks signés vers /api/stripe/webhook ;
 *   2. aux tests (webhook valide, webhook invalide, webhook répété).
 *
 * La vérification, elle, est toujours déléguée au SDK Stripe officiel
 * (`stripe.webhooks.constructEvent`), jamais réimplémentée à la main.
 */

export function signPayload(payload: string, secret: string, timestampSeconds = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac("sha256", secret).update(`${timestampSeconds}.${payload}`).digest("hex");
  return `t=${timestampSeconds},v1=${signature}`;
}

/** Signature volontairement invalide (utilisée par les tests de sécurité). */
export function signPayloadWithWrongSecret(payload: string, wrongSecret = "whsec_cle_incorrecte"): string {
  return signPayload(payload, wrongSecret);
}

/** Signature avec un horodatage ancien → doit être rejetée (protection contre le rejeu). */
export function signPayloadWithOldTimestamp(payload: string, secret: string, ageSeconds = 60 * 60 * 24): string {
  return signPayload(payload, secret, Math.floor(Date.now() / 1000) - ageSeconds);
}

export function newEventId(prefix = "evt"): string {
  return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

/** Comparaison à temps constant, utilisée pour les jetons de confirmation côté admin. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

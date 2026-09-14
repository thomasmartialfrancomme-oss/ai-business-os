import { processWebhook } from "@/lib/payments/webhook";

/**
 * ══════════════════════════════════════════════════════════════════════════════
 *  POST /api/stripe/webhook — POINT D'ENTRÉE DES ÉVÉNEMENTS STRIPE
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Sécurité appliquée, dans cet ordre :
 *   1. corps BRUT conservé tel quel (obligatoire : la signature porte sur les octets exacts) ;
 *   2. en-tête Stripe-Signature vérifié par le SDK officiel (HMAC-SHA256 + fenêtre de 5 min) ;
 *   3. cohérence test/live avec l'environnement configuré ;
 *   4. idempotence par identifiant d'événement (un webhook répété n'est jamais rejoué) ;
 *   5. seule étape qui écrit l'état des abonnements et des paiements.
 *
 * Codes de retour :
 *  200 — événement authentique traité (ou déjà traité) → Stripe arrête les relances
 *  400 — signature invalide / environnement incohérent → Stripe ne réessaie pas
 *  500 — erreur de traitement → Stripe réessaie avec un back-off exponentiel
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const signature = request.headers.get("stripe-signature");

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const result = await processWebhook(rawBody, signature);
  return Response.json(result.body, { status: result.status });
}

/** GET : sonde de disponibilité (utile au diagnostic ou au monitoring). */
export async function GET(): Promise<Response> {
  return Response.json({
    endpoint: "/api/stripe/webhook",
    method: "POST",
    signatureRequired: "Stripe-Signature",
    message: "Endpoint prêt. Les événements sont traités uniquement après vérification de signature.",
  });
}

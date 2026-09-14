import { env } from "../env";
import { getWebhookSecret } from ".";
import { signPayload } from "./signature";
import { processWebhook } from "./webhook";
import type { StripeEvent } from "./types";

/**
 * Livraison des événements émis par la passerelle vers NOTRE webhook.
 *
 * En PRODUCTION / TEST avec un vrai compte Stripe : jamais utilisée — Stripe livre
 * lui-même ses événements (avec relances automatiques en cas d'échec).
 *
 * En SIMULATION : cette fonction joue le rôle des serveurs Stripe. Elle sérialise
 * l'événement, calcule la signature HMAC-SHA256 (en-tête Stripe-Signature) puis
 * l'injecte dans le MÊME pipeline que celui utilisé en production : vérification
 * de signature par le SDK Stripe, contrôle d'environnement, idempotence, application.
 *
 * Deux modes de livraison :
 *   - "in-process" (défaut) : appel direct du pipeline, aucune dépendance réseau.
 *   - "http" : POST réel sur {APP_URL}/api/stripe/webhook (utile pour tout voir
 *     passer dans les logs du serveur, ou depuis un tunnel ngrok).
 */
export interface DeliveryResult {
  eventId: string;
  type: string;
  status: number;
  body: string;
}

export async function deliverEvents(
  events: StripeEvent<Record<string, unknown>>[],
  options: { transport?: "in-process" | "http"; baseUrl?: string } = {}
): Promise<DeliveryResult[]> {
  if (events.length === 0) return [];

  const secret = await getWebhookSecret();
  if (!secret) {
    console.warn("[events] aucun secret de webhook : événements non livrés.");
    return [];
  }

  const transport = options.transport ?? (process.env.SIM_DELIVER_VIA_HTTP === "true" ? "http" : "in-process");
  const baseUrl = options.baseUrl ?? env.APP_URL;
  const results: DeliveryResult[] = [];

  for (const event of events) {
    const payload = JSON.stringify(event);
    const signature = signPayload(payload, secret);

    if (transport === "http") {
      try {
        const response = await fetch(`${baseUrl}/api/stripe/webhook`, {
          method: "POST",
          headers: { "content-type": "application/json", "stripe-signature": signature },
          body: payload,
        });
        const body = await response.text();
        results.push({ eventId: event.id, type: event.type, status: response.status, body });
      } catch (error) {
        results.push({ eventId: event.id, type: event.type, status: 0, body: String(error) });
      }
      continue;
    }

    const result = await processWebhook(payload, signature);
    results.push({
      eventId: event.id,
      type: event.type,
      status: result.status,
      body: JSON.stringify(result.body),
    });
  }

  return results;
}

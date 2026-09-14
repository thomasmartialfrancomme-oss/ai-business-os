import { env } from "@/lib/env";
import { assertSameOrigin, errorResponse, json } from "@/lib/http";
import { getGateway } from "@/lib/payments";
import { deliverEvents } from "@/lib/payments/events";
import type { SimulationAction } from "@/lib/payments/types";

/**
 * POST /api/sim/actions — panneau de simulation (MODE SIMULATION UNIQUEMENT).
 *
 * Reproduit les actions que seul Stripe peut déclencher : payer une session,
 * renouveler un abonnement, provoquer un échec de paiement, expirer une session.
 * Les événements produits sont de vrais événements signés qui traversent
 * /api/stripe/webhook (vérification de signature + idempotence incluses).
 *
 * Dès qu'une clé STRIPE_SECRET_KEY est présente, ces routes renvoient 404 :
 * avec un vrai compte Stripe, le navigateur de test Stripe joue ce rôle.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);

    if (!env.simulationAllowed || env.stripeMode !== "simulation") {
      return json(
        {
          error: "simulation_disabled",
          message:
            "Mode simulation inactif : un compte Stripe est configuré. Utilisez le tableau de bord Stripe (ou les cartes de test) pour déclencher des événements.",
        },
        404
      );
    }

    const gateway = getGateway();
    if (!gateway.simulate) {
      return json({ error: "simulation_unavailable" }, 404);
    }

    const body = (await request.json().catch(() => ({}))) as SimulationAction;
    if (!body?.type) return json({ error: "missing_action" }, 400);

    const outcome = await gateway.simulate(body);
    const deliveries = await deliverEvents(outcome.events);

    return json({
      simulated: true,
      action: body.type,
      data: outcome.data,
      events: outcome.events.map((event) => ({ id: event.id, type: event.type })),
      deliveries,
      message: `${outcome.events.length} événement(s) Stripe signé(s) livré(s) au webhook.`,
    });
  } catch (error) {
    return errorResponse(error, "sim/actions");
  }
}

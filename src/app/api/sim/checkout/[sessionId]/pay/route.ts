import { env } from "@/lib/env";
import { assertSameOrigin, errorResponse, json } from "@/lib/http";
import { getGateway } from "@/lib/payments";
import { deliverEvents } from "@/lib/payments/events";
import { prisma } from "@/lib/db";

/**
 * POST /api/sim/checkout/:sessionId/pay — équivalent simulé du formulaire de carte Stripe.
 *
 * ⚠️ MODE SIMULATION UNIQUEMENT (404 dès qu'une clé Stripe est configurée).
 * Aucune donnée de carte n'est reçue ni stockée : le corps ne contient qu'une
 * décision de scénario ("success", "declined", …), comme le ferait le test
 * navigateur de Stripe avec une carte de test.
 *
 * Sécurité : cette route ne modifie aucun état en base. Elle demande à la
 * passerelle de fabriquer les événements que Stripe émettrait, puis les livre
 * signés à /api/stripe/webhook — seul endroit qui écrit l'état.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ sessionId: string }> }): Promise<Response> {
  try {
    assertSameOrigin(request);

    if (!env.simulationAllowed || env.stripeMode !== "simulation") {
      return json({ error: "simulation_disabled" }, 404);
    }

    const { sessionId } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { outcome?: string; card?: string };
    const outcome = (body.outcome ?? "success") as "success" | "declined" | "insufficient_funds" | "requires_action";

    const session = await prisma.simObject.findUnique({ where: { id: sessionId } });
    if (!session || session.type !== "checkout_session") {
      return json({ error: "session_not_found", message: "Session de paiement inconnue." }, 404);
    }

    const gateway = getGateway();
    if (!gateway.simulate) return json({ error: "simulation_unavailable" }, 404);

    const result = await gateway.simulate({ type: "pay_checkout", sessionId, outcome });
    const deliveries = await deliverEvents(result.events);

    // Aucune donnée de carte n'est journalisée : uniquement la décision de scénario.
    await prisma.auditLog.create({
      data: {
        actorType: "SYSTEM",
        action: "sim.checkout_attempt",
        targetType: "checkout_session",
        targetId: sessionId,
        metadata: { outcome, card: body.card ?? null, events: result.events.map((e) => e.type) },
      },
    });

    return json({
      simulated: true,
      outcome,
      data: result.data,
      deliveries,
      // Le client ne décide de rien : seul le statut renvoyé par le serveur compte,
      // et il provient du webhook désormais appliqué en base.
      message:
        outcome === "success"
          ? "Paiement accepté. Les événements Stripe signés ont été livrés au webhook."
          : "Paiement refusé. Aucun accès accordé.",
    });
  } catch (error) {
    return errorResponse(error, "sim/checkout/pay");
  }
}

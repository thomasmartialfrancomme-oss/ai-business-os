import { getSessionUser } from "@/lib/auth";
import { assertSameOrigin, errorResponse, json } from "@/lib/http";
import { cancelSubscription, resumeSubscription } from "@/lib/payments/service";

/**
 * POST /api/billing/cancel
 * Corps : { action: "cancel" | "resume" }
 *
 * "cancel" programme la résiliation à la fin de la période déjà payée
 * (cancel_at_period_end) : le client garde l'accès jusqu'à l'échéance, Stripe
 * ne prélève plus. L'état définitif est écrit par le webhook
 * customer.subscription.updated, puis customer.subscription.deleted à l'échéance.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await getSessionUser();
    if (!user) return json({ error: "unauthenticated" }, 401);

    const body = (await request.json().catch(() => ({}))) as { action?: string };
    if (body.action === "resume") {
      const result = await resumeSubscription({ user });
      return json({ ...result, message: "Résiliation annulée : l'abonnement sera renouvelé automatiquement." });
    }
    if (body.action !== "cancel") return json({ error: "unknown_action" }, 400);

    const result = await cancelSubscription({ user });
    return json({
      ...result,
      message: "Résiliation programmée en fin de période. Aucun nouveau prélèvement ne sera effectué.",
    });
  } catch (error) {
    return errorResponse(error, "billing/cancel");
  }
}

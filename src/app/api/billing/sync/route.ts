import { getSessionUser } from "@/lib/auth";
import { assertSameOrigin, errorResponse, json, rateLimit } from "@/lib/http";
import { syncSubscriptionFromProvider } from "@/lib/payments/service";
import { writeAudit } from "@/lib/audit";

/**
 * POST /api/billing/sync — resynchronisation à la demande.
 *
 * Utile si un webhook a été manqué (panne, déploiement). La relecture se fait
 * À LA SOURCE (API du fournisseur) : elle ne peut donc que refléter la vérité
 * du fournisseur, jamais une déclaration du navigateur.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await getSessionUser();
    if (!user) return json({ error: "unauthenticated" }, 401);
    rateLimit(`sync:${user.id}`, 6, 60_000);

    const result = await syncSubscriptionFromProvider({ user });

    await writeAudit({
      actorType: "CUSTOMER",
      actorId: user.id,
      action: "subscription.manual_sync",
      targetType: "subscription",
      targetId: user.id,
      userId: user.id,
      metadata: result,
    });

    return json({ ...result, message: "Abonnement resynchronisé depuis le fournisseur de paiement." });
  } catch (error) {
    return errorResponse(error, "billing/sync");
  }
}

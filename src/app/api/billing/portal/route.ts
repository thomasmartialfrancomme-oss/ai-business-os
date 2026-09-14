import { getSessionUser } from "@/lib/auth";
import { assertSameOrigin, errorResponse, getOrigin, json, rateLimit } from "@/lib/http";
import { createBillingPortalSession } from "@/lib/payments/service";

/**
 * POST /api/billing/portal — « Mettre à jour le moyen de paiement » / « Voir mes factures ».
 *
 * Renvoie l'URL du portail de facturation hébergé par Stripe : la saisie et la
 * modification de la carte se font chez Stripe, jamais sur nos serveurs.
 * Aucune donnée de carte ne transite ni n'est stockée dans l'application.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await getSessionUser();
    if (!user) return json({ error: "unauthenticated" }, 401);
    rateLimit(`portal:${user.id}`, 10, 60_000);

    const result = await createBillingPortalSession({ user, origin: getOrigin(request) });
    return json({ ...result, message: "Redirection vers le portail de facturation sécurisé." });
  } catch (error) {
    return errorResponse(error, "billing/portal");
  }
}

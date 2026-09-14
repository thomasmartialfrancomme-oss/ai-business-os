import { getSessionUser } from "@/lib/auth";
import { assertSameOrigin, errorResponse, getOrigin, json, rateLimit } from "@/lib/http";
import { createSubscriptionCheckout } from "@/lib/payments/service";
import { isBillingInterval, isPlanCode } from "@/lib/plans";

/**
 * POST /api/billing/checkout
 * Corps : { planCode: "STARTER"|"PRO"|"BUSINESS", interval: "MONTH"|"YEAR" }
 *
 * Crée une session Stripe Checkout côté serveur et renvoie l'URL de redirection.
 * Le montant n'est jamais accepté depuis le client : il est recalculé ici
 * à partir du catalogue (src/lib/plans.ts).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);

    const user = await getSessionUser();
    if (!user) return json({ error: "unauthenticated", message: "Connexion requise." }, 401);

    rateLimit(`checkout:${user.id}`, 10, 60_000);

    const body = (await request.json().catch(() => ({}))) as { planCode?: string; interval?: string };
    if (!isPlanCode(body.planCode)) return json({ error: "unknown_plan", message: "Forfait inconnu." }, 400);
    if (!isBillingInterval(body.interval ?? "MONTH")) {
      return json({ error: "unknown_interval", message: "Périodicité inconnue." }, 400);
    }

    const result = await createSubscriptionCheckout({
      user,
      planCode: body.planCode,
      interval: body.interval ?? "MONTH",
      origin: getOrigin(request),
    });

    return json({ ...result, message: "Session Checkout créée. Redirection vers Stripe…" });
  } catch (error) {
    return errorResponse(error, "billing/checkout");
  }
}

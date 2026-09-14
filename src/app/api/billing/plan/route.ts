import { getSessionUser } from "@/lib/auth";
import { assertSameOrigin, errorResponse, getOrigin, json, rateLimit } from "@/lib/http";
import { changePlan } from "@/lib/payments/service";
import { isBillingInterval, isPlanCode } from "@/lib/plans";

/** POST /api/billing/plan — changement de forfait (montée en gamme au prorata, descente sans prorata). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await getSessionUser();
    if (!user) return json({ error: "unauthenticated" }, 401);
    rateLimit(`plan:${user.id}`, 10, 60_000);

    const body = (await request.json().catch(() => ({}))) as { planCode?: string; interval?: string };
    if (!isPlanCode(body.planCode)) return json({ error: "unknown_plan" }, 400);
    if (!isBillingInterval(body.interval ?? "MONTH")) return json({ error: "unknown_interval" }, 400);

    const result = await changePlan({
      user,
      planCode: body.planCode,
      interval: body.interval ?? "MONTH",
      origin: getOrigin(request),
    });

    return json({
      ...result,
      message:
        "Changement de forfait demandé. L'abonnement sera confirmé par le webhook du fournisseur de paiement.",
    });
  } catch (error) {
    return errorResponse(error, "billing/plan");
  }
}

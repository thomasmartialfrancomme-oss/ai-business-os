import { getSessionUser } from "@/lib/auth";
import { hasAccess } from "@/lib/access";
import { prisma } from "@/lib/db";
import { errorResponse, json } from "@/lib/http";

/**
 * GET /api/billing/subscription/status
 *
 * ⚠️ LECTURE SEULE. Cette route ne peut en aucun cas activer un abonnement :
 * elle se contente de relire en base l'état écrit par les webhooks Stripe.
 *
 * C'est ce que la page /billing/success interroge en boucle : le client ne fait
 * que constater la décision du backend. Si le webhook n'a pas encore été traité,
 * la réponse indique « en attente » — jamais « payé ».
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const user = await getSessionUser();
    if (!user) return json({ error: "unauthenticated" }, 401);

    const subscription = await prisma.subscription.findUnique({ where: { userId: user.id } });
    const access = hasAccess(subscription);

    return json({
      planCode: subscription?.planCode ?? null,
      interval: subscription?.interval ?? null,
      status: subscription?.status ?? null,
      stripeSubscriptionId: subscription?.stripeSubscriptionId ?? null,
      currentPeriodStart: subscription?.currentPeriodStart ?? null,
      currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
      lastPaymentStatus: subscription?.lastPaymentStatus ?? null,
      lastPaymentAt: subscription?.lastPaymentAt ?? null,
      access: { allowed: access.allowed, reason: access.reason, accessUntil: access.accessUntil },
      // Horodatage serveur : le frontend ne peut pas « décider » que c'est payé.
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    return errorResponse(error, "billing/subscription/status");
  }
}

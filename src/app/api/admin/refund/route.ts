import { getOwnerForApi } from "@/lib/auth";
import { writeAudit } from "@/lib/audit";
import { assertSameOrigin, errorResponse, json } from "@/lib/http";
import { getGateway } from "@/lib/payments";
import { deliverEvents } from "@/lib/payments/events";
import { prisma } from "@/lib/db";

/**
 * POST /api/admin/refund
 * Corps : { invoiceId?, paymentIntentId?, amountCents? }
 *
 * Remboursement (total ou partiel) déclenché par le propriétaire.
 * L'état est mis à jour par le webhook charge.refunded émis par le fournisseur —
 * sauf en simulation où les événements correspondants sont livrés immédiatement.
 * Un remboursement ne coupe ni ne prolonge automatiquement l'accès : la décision
 * commerciale reste humaine (elle est journalisée).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const auth = await getOwnerForApi();
    if (!auth.ok) return json({ error: auth.error, message: auth.message }, auth.status);
    const owner = auth.user;

    const body = (await request.json().catch(() => ({}))) as {
      invoiceId?: string;
      paymentIntentId?: string;
      amountCents?: number;
    };

    let paymentIntentId = body.paymentIntentId ?? null;
    let invoiceId: string | null = body.invoiceId ?? null;

    if (!paymentIntentId && invoiceId) {
      const payment = await prisma.payment.findFirst({
        where: { invoiceId, status: { in: ["SUCCEEDED", "PARTIALLY_REFUNDED"] } },
        orderBy: { createdAt: "desc" },
      });
      paymentIntentId = payment?.stripePaymentIntentId ?? null;
    }

    if (!paymentIntentId) {
      return json({ error: "no_payment_found", message: "Aucun paiement Stripe remboursable pour cette facture." }, 404);
    }

    const gateway = getGateway();
    const outcome = await gateway.refund({ paymentIntentId, amountCents: body.amountCents });

    await writeAudit({
      actorType: "ADMIN",
      actorId: owner.id,
      action: "refund.requested",
      targetType: "payment",
      targetId: paymentIntentId,
      metadata: { amountCents: outcome.data.amountCents, refundId: outcome.data.refundId, mode: gateway.mode },
    });

    // En mode simulation, on rejoue les événements que Stripe enverrait.
    const deliveries = await deliverEvents(outcome.events);

    return json({
      refundId: outcome.data.refundId,
      amountCents: outcome.data.amountCents,
      simulated: outcome.simulated,
      deliveries,
      message: `Remboursement de ${(outcome.data.amountCents / 100).toFixed(2)} € enregistré.`,
    });
  } catch (error) {
    return errorResponse(error, "admin/refund");
  }
}

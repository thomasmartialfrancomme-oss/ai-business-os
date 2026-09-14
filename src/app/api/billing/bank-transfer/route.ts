import { getSessionUser } from "@/lib/auth";
import { assertSameOrigin, errorResponse, json, rateLimit } from "@/lib/http";
import { createBankTransferInvoice, getBankDetails } from "@/lib/payments/bank-transfer";
import { isBillingInterval, isPlanCode } from "@/lib/plans";
import { prisma } from "@/lib/db";

/**
 * POST /api/billing/bank-transfer — demander à payer par virement bancaire.
 * Corps : { planCode, interval }
 *
 * Crée une facture au statut AWAITING_BANK_TRANSFER avec une référence unique
 * et renvoie les coordonnées bancaires configurées par l'administrateur.
 * AUCUN accès n'est accordé à ce stade.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await getSessionUser();
    if (!user) return json({ error: "unauthenticated" }, 401);
    rateLimit(`bank-transfer:${user.id}`, 6, 60_000);

    const body = (await request.json().catch(() => ({}))) as { planCode?: string; interval?: string };
    if (!isPlanCode(body.planCode)) return json({ error: "unknown_plan" }, 400);
    if (!isBillingInterval(body.interval ?? "MONTH")) return json({ error: "unknown_interval" }, 400);

    const result = await createBankTransferInvoice({
      user,
      planCode: body.planCode,
      interval: body.interval ?? "MONTH",
    });

    return json({
      ...result,
      message:
        "Facture émise en attente de virement. Votre accès sera activé après confirmation du paiement par nos services.",
    });
  } catch (error) {
    return errorResponse(error, "billing/bank-transfer");
  }
}

/** GET : coordonnées bancaires + facture en attente (affichées dans /billing). */
export async function GET(): Promise<Response> {
  try {
    const user = await getSessionUser();
    if (!user) return json({ error: "unauthenticated" }, 401);

    const [bankDetails, awaiting] = await Promise.all([
      getBankDetails(),
      prisma.invoice.findFirst({
        where: { userId: user.id, status: "AWAITING_BANK_TRANSFER" },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    return json({ bankDetails: { ...bankDetails, iban: bankDetails.iban }, awaitingInvoice: awaiting });
  } catch (error) {
    return errorResponse(error, "billing/bank-transfer GET");
  }
}

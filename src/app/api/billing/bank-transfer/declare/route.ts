import { getSessionUser } from "@/lib/auth";
import { assertSameOrigin, errorResponse, json, rateLimit } from "@/lib/http";
import { declareBankTransfer } from "@/lib/payments/bank-transfer";

/**
 * POST /api/billing/bank-transfer/declare
 * Corps : { invoiceId, reference, note? }
 *
 * Le client signale qu'il a effectué le virement. C'est une DÉCLARATION :
 * elle déclenche une vérification côté administrateur et NE modifie pas le
 * statut de la facture (qui reste AWAITING_BANK_TRANSFER).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const user = await getSessionUser();
    if (!user) return json({ error: "unauthenticated" }, 401);
    rateLimit(`bank-declare:${user.id}`, 10, 60_000);

    const body = (await request.json().catch(() => ({}))) as { invoiceId?: string; reference?: string; note?: string };
    if (!body.invoiceId || !body.reference) return json({ error: "missing_fields" }, 400);

    const result = await declareBankTransfer({
      user,
      invoiceId: body.invoiceId,
      reference: body.reference,
      note: body.note,
    });

    return json({
      ...result,
      status: "AWAITING_BANK_TRANSFER",
      message:
        "Déclaration enregistrée. Votre facture reste en attente : elle ne sera marquée payée qu'après vérification du virement reçu.",
    });
  } catch (error) {
    return errorResponse(error, "billing/bank-transfer/declare");
  }
}

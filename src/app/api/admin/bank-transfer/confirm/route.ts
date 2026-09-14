import { getOwnerForApi } from "@/lib/auth";
import { assertSameOrigin, errorResponse, json } from "@/lib/http";
import { confirmBankTransfer } from "@/lib/payments/bank-transfer";

/**
 * POST /api/admin/bank-transfer/confirm
 * Corps : { invoiceId, reference, note?, recordInStripe? }
 *
 * PROCÉDURE ADMINISTRATIVE SÉCURISÉE de confirmation d'un virement :
 *  - réservée au propriétaire de la plateforme (rôle OWNER) ;
 *  - exige la référence exacte de la facture (preuve de rapprochement) ;
 *  - journalise l'auteur et l'horodatage ;
 *  - c'est la SEULE voie qui fait passer une facture virement à PAID et qui
 *    active l'abonnement correspondant.
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
      reference?: string;
      note?: string;
      recordInStripe?: boolean;
    };

    if (!body.invoiceId || !body.reference) return json({ error: "missing_fields" }, 400);

    const result = await confirmBankTransfer({
      owner,
      invoiceId: body.invoiceId,
      reference: body.reference,
      note: body.note,
      recordInStripe: Boolean(body.recordInStripe),
    });

    return json({ ...result, message: "Virement confirmé : facture payée et abonnement activé." });
  } catch (error) {
    return errorResponse(error, "admin/bank-transfer/confirm");
  }
}

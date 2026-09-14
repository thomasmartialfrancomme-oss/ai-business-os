import { getOwnerForApi } from "@/lib/auth";
import { assertSameOrigin, errorResponse, json } from "@/lib/http";
import { getBankDetails, saveBankDetails } from "@/lib/payments/bank-transfer";

/**
 * POST /api/admin/bank-details — coordonnées bancaires de réception du propriétaire.
 * Réservé au rôle OWNER. Ces coordonnées sont celles affichées aux clients qui
 * choisissent le virement bancaire (aucune donnée de carte n'est concernée).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const auth = await getOwnerForApi();
    if (!auth.ok) return json({ error: auth.error, message: auth.message }, auth.status);
    const owner = auth.user;

    const body = (await request.json().catch(() => ({}))) as Record<string, string | undefined>;
    await saveBankDetails(owner, {
      accountHolder: body.accountHolder?.trim(),
      bankName: body.bankName?.trim(),
      iban: body.iban?.replace(/\s+/g, "").toUpperCase(),
      bic: body.bic?.replace(/\s+/g, "").toUpperCase(),
      bankAddress: body.bankAddress?.trim(),
      note: body.note?.trim(),
    });

    const details = await getBankDetails();
    return json({ ...details, message: "Coordonnées bancaires enregistrées." });
  } catch (error) {
    return errorResponse(error, "admin/bank-details");
  }
}

export async function GET(): Promise<Response> {
  try {
    const auth = await getOwnerForApi();
    if (!auth.ok) return json({ error: auth.error, message: auth.message }, auth.status);
    return json(await getBankDetails());
  } catch (error) {
    return errorResponse(error, "admin/bank-details GET");
  }
}

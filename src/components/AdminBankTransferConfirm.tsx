"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Confirmation d'un virement bancaire (procédure administrative sécurisée).
 *
 * Double contrôle : rôle OWNER côté serveur + saisie de la référence exacte de la
 * facture. C'est la seule voie qui fait passer une facture à PAID et active
 * l'abonnement correspondant. Tout est journalisé (qui, quand, quelle référence).
 */
export function AdminBankTransferConfirm({
  invoiceId,
  reference,
  amountLabel,
  mode,
}: {
  invoiceId: string;
  reference: string;
  amountLabel: string;
  mode: "live" | "test" | "simulation";
}) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [recordInStripe, setRecordInStripe] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: string; text: string } | null>(null);

  const matches = value.trim().toUpperCase() === reference.toUpperCase();

  async function confirm() {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/admin/bank-transfer/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invoiceId, reference: value, note, recordInStripe }),
      });
      const data = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        setFeedback({ tone: "danger", text: String(data.message ?? "Confirmation refusée.") });
        return;
      }
      setFeedback({ tone: "success", text: String(data.message) });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack mt-4" style={{ gap: 10 }}>
      <div className="grid grid-2" style={{ gap: 10 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor={`ref-${invoiceId}`}>Référence de la facture (obligatoire)</label>
          <input
            id={`ref-${invoiceId}`}
            type="text"
            value={value}
            placeholder="AIB-2026-XXXXXXXX"
            className="mono"
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor={`note-admin-${invoiceId}`}>Note interne (référence bancaire, date de valeur…)</label>
          <input
            id={`note-admin-${invoiceId}`}
            type="text"
            value={note}
            placeholder="Ex. crédit reçu le 14/09, relevé n°4821"
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      </div>

      {mode !== "simulation" && (
        <label className="row" style={{ gap: 8, textTransform: "none", fontSize: 13 }}>
          <input
            type="checkbox"
            checked={recordInStripe}
            onChange={(event) => setRecordInStripe(event.target.checked)}
            style={{ width: "auto" }}
          />
          Enregistrer aussi le règlement dans Stripe (facture hors ligne, sans moyen de paiement)
        </label>
      )}

      <div className="btn-group">
        <button type="button" className="btn btn-sm btn-success" disabled={!matches || busy} onClick={confirm}>
          {busy ? <span className="spinner" /> : null}
          Confirmer la réception du virement ({amountLabel})
        </button>
        <span className="hint-inline">
          {matches ? "Référence vérifiée — confirmation possible." : "Saisissez la référence exacte pour débloquer la confirmation."}
        </span>
      </div>

      {feedback && <div className={`alert alert-${feedback.tone}`}>{feedback.text}</div>}
    </div>
  );
}

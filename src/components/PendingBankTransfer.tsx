"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatMoney } from "@/lib/format";

/**
 * Facture en attente de virement bancaire.
 *
 * Le client peut déclarer son virement, mais cela ne change PAS le statut :
 * la facture reste AWAITING_BANK_TRANSFER jusqu'à confirmation par
 * l'administrateur après rapprochement bancaire.
 */
export function PendingBankTransfer({
  invoiceId,
  reference,
  amountDue,
  currency,
  declared,
}: {
  invoiceId: string;
  reference: string;
  amountDue: number;
  currency: string;
  declared: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [feedback, setFeedback] = useState<{ tone: string; text: string } | null>(null);

  async function declare() {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/billing/bank-transfer/declare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invoiceId, reference, note }),
      });
      const data = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        setFeedback({ tone: "danger", text: String(data.message ?? "Déclaration impossible.") });
        return;
      }
      setFeedback({ tone: "success", text: String(data.message) });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card card-warning mt-6">
      <div className="row-between">
        <h3>Facture en attente de virement bancaire</h3>
        <span className="badge badge-warning">AWAITING_BANK_TRANSFER</span>
      </div>
      <p className="dim mt-2">
        Référence <strong className="mono">{reference}</strong> — montant{" "}
        <strong>{formatMoney(amountDue, currency)}</strong>. Indiquez impérativement la référence dans le libellé du
        virement afin que le rapprochement bancaire soit possible.
      </p>

      {declared ? (
        <div className="alert alert-info">
          Virement déclaré. Nous vérifions la réception des fonds : la facture passera à <span className="mono">PAID</span> et
          votre abonnement sera activé à ce moment-là (confirmation administrative tracée).
        </div>
      ) : (
        <div className="stack" style={{ gap: 10 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor={`note-${invoiceId}`}>Référence du virement côté banque (facultatif)</label>
            <input
              id={`note-${invoiceId}`}
              type="text"
              value={note}
              placeholder="Ex. virement émis le 14/09, réf. bancaire 88213"
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <div className="btn-group">
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={declare}>
              {busy ? <span className="spinner" /> : null}
              J'ai effectué le virement
            </button>
          </div>
          <p className="dim" style={{ marginBottom: 0 }}>
            Cette déclaration ne vaut pas preuve de paiement : l'activation n'aura lieu qu'après confirmation du
            virement reçu par nos services.
          </p>
        </div>
      )}

      {feedback && <div className={`alert alert-${feedback.tone} mt-2`}>{feedback.text}</div>}
    </div>
  );
}

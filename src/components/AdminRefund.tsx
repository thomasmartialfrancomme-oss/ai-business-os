"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Remboursement déclenché par le propriétaire.
 *
 * Le remboursement est exécuté par Stripe ; notre base est mise à jour par
 * l'événement charge.refunded (ou immédiatement en mode simulation, via le même
 * pipeline de webhook). L'accès n'est ni coupé ni prolongé automatiquement.
 */
export function AdminRefund({ paymentIntentId, amountLabel }: { paymentIntentId: string; amountLabel: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: string; text: string } | null>(null);

  async function refund() {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/admin/refund", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paymentIntentId }),
      });
      const data = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        setFeedback({ tone: "danger", text: String(data.message ?? "Remboursement impossible.") });
        return;
      }
      setFeedback({ tone: "success", text: String(data.message) });
      setOpen(false);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 6, alignItems: "flex-end" }}>
      {!open ? (
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(true)}>
          Rembourser
        </button>
      ) : (
        <>
          <span className="hint-inline">Rembourser {amountLabel} ?</span>
          <div className="btn-group" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={refund}>
              {busy ? <span className="spinner" /> : null}
              Confirmer
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(false)}>
              Annuler
            </button>
          </div>
        </>
      )}
      {feedback && <span className={`badge ${feedback.tone === "success" ? "badge-success" : "badge-danger"}`}>{feedback.text}</span>}
    </div>
  );
}

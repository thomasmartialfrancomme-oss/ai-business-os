"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Formulaire des coordonnées de réception (réservé au propriétaire). */
export function BankDetailsForm({
  initial,
  configured,
}: {
  initial: {
    accountHolder: string;
    bankName: string;
    iban: string;
    bic: string;
    bankAddress: string;
    note: string;
  };
  configured: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: string; text: string } | null>(null);

  function update(key: keyof typeof form) {
    return (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((current) => ({ ...current, [key]: event.target.value }));
  }

  async function save() {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch("/api/admin/bank-details", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        setFeedback({ tone: "danger", text: String(data.message ?? "Enregistrement impossible.") });
        return;
      }
      setFeedback({ tone: "success", text: "Coordonnées bancaires enregistrées." });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack mt-2" style={{ gap: 12 }}>
      {!configured && (
        <div className="alert alert-warning">
          Aucune coordonnée bancaire complète : le paiement par virement est actuellement indisponible pour vos clients
          (IBAN et titulaire requis).
        </div>
      )}

      <div className="grid grid-2" style={{ gap: 12 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="accountHolder">Titulaire du compte *</label>
          <input id="accountHolder" value={form.accountHolder} onChange={update("accountHolder")} placeholder="AI Business OS SAS" />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="bankName">Banque</label>
          <input id="bankName" value={form.bankName} onChange={update("bankName")} placeholder="Nom de la banque / agence" />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="iban">IBAN *</label>
          <input id="iban" className="mono" value={form.iban} onChange={update("iban")} placeholder="FR76…" />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="bic">BIC / SWIFT</label>
          <input id="bic" className="mono" value={form.bic} onChange={update("bic")} placeholder="AGRIFRPP…" />
        </div>
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="bankAddress">Adresse de la banque</label>
        <input id="bankAddress" value={form.bankAddress} onChange={update("bankAddress")} />
      </div>

      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="note">Consignes affichées au client</label>
        <textarea id="note" rows={2} value={form.note} onChange={update("note")} />
      </div>

      <div className="btn-group">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>
          {busy ? <span className="spinner" /> : null}
          Enregistrer
        </button>
        <span className="hint-inline">
          Ces coordonnées sont des informations de réception : aucune donnée de carte n'est concernée.
        </span>
      </div>

      {feedback && <div className={`alert alert-${feedback.tone}`}>{feedback.text}</div>}
    </div>
  );
}

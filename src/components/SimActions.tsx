"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Déclenche les événements Stripe simulés (renouvellement, échec, expiration). */
export function SimActions({
  subscriptionId,
  cancelAtPeriodEnd,
  status,
}: {
  subscriptionId: string;
  cancelAtPeriodEnd: boolean;
  status: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: string; text: string } | null>(null);

  async function run(body: Record<string, unknown>, label: string) {
    setBusy(label);
    setFeedback(null);
    try {
      const response = await fetch("/api/sim/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        setFeedback({ tone: "danger", text: String(data.message ?? "Action impossible.") });
        return;
      }
      const events = (data.events as Array<{ type: string }>) ?? [];
      setFeedback({
        tone: "success",
        text: `${events.length} événement(s) signé(s) livré(s) : ${events.map((e) => e.type).join(", ") || "aucun"}`,
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack mt-2" style={{ gap: 8 }}>
      <div className="btn-group">
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy !== null || status === "CANCELED"}
          onClick={() => run({ type: "renew_subscription", subscriptionId, outcome: "success" }, "renew-ok")}
        >
          {busy === "renew-ok" ? <span className="spinner" /> : null}
          Simuler le renouvellement (paiement accepté)
        </button>
        <button
          type="button"
          className="btn btn-sm btn-danger"
          disabled={busy !== null || status === "CANCELED"}
          onClick={() => run({ type: "renew_subscription", subscriptionId, outcome: "failed" }, "renew-ko")}
        >
          {busy === "renew-ko" ? <span className="spinner" /> : null}
          Simuler un échec de paiement
        </button>
        <span className="hint-inline">
          Statut {status}
          {cancelAtPeriodEnd ? " · résiliation programmée" : ""}
        </span>
      </div>
      {feedback && <div className={`alert alert-${feedback.tone}`}>{feedback.text}</div>}
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Actions de l'espace facturation.
 *
 * Aucune de ces actions ne déclare un paiement réussi : elles demandent au serveur
 * d'agir chez le fournisseur de paiement (portail client, résiliation, resynchro),
 * puis rafraîchissent l'affichage à partir de la base de données.
 */
export function BillingActions({
  cancelAtPeriodEnd,
  hasStripeSubscription,
  mode,
}: {
  cancelAtPeriodEnd: boolean;
  hasStripeSubscription: boolean;
  mode: "live" | "test" | "simulation";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: string; text: string } | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function post(path: string, body: Record<string, unknown>, label: string, redirectField?: string) {
    setBusy(label);
    setFeedback(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        setFeedback({ tone: "danger", text: String(data.message ?? "Action impossible.") });
        return;
      }
      if (redirectField && data[redirectField]) {
        window.location.href = String(data[redirectField]);
        return;
      }
      setFeedback({ tone: "success", text: String(data.message ?? "Action enregistrée.") });
      setConfirming(false);
      router.refresh();
    } catch {
      setFeedback({ tone: "danger", text: "Erreur réseau : action non enregistrée." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="btn-group">
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy !== null || !hasStripeSubscription}
          onClick={() => post("/api/billing/portal", {}, "portal", "url")}
          title={
            mode === "simulation"
              ? "En mode simulation, le portail Stripe est remplacé par cette page"
              : "Ouvre le portail de facturation sécurisé hébergé par Stripe"
          }
        >
          {busy === "portal" ? <span className="spinner" /> : null}
          Mettre à jour le moyen de paiement
        </button>

        {cancelAtPeriodEnd ? (
          <button
            type="button"
            className="btn btn-sm btn-success"
            disabled={busy !== null}
            onClick={() => post("/api/billing/cancel", { action: "resume" }, "resume")}
          >
            {busy === "resume" ? <span className="spinner" /> : null}
            Reprendre l'abonnement
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={busy !== null || !hasStripeSubscription}
            onClick={() => setConfirming(true)}
          >
            Annuler l'abonnement
          </button>
        )}

        <button
          type="button"
          className="btn btn-sm btn-ghost"
          disabled={busy !== null || !hasStripeSubscription}
          onClick={() => post("/api/billing/sync", {}, "sync")}
          title="Relit l'état de l'abonnement à la source (utile si un webhook a été manqué)"
        >
          {busy === "sync" ? <span className="spinner" /> : null}
          Synchroniser l'état
        </button>
      </div>

      {confirming && (
        <div className="alert alert-warning">
          <strong>Confirmer l'annulation ?</strong>
          <p className="mt-2" style={{ marginBottom: 8 }}>
            L'abonnement ne sera pas renouvelé. Vous conservez l'accès jusqu'à la fin de la période déjà payée, puis
            l'accès à AI Business OS sera suspendu.
          </p>
          <div className="btn-group">
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={busy !== null}
              onClick={() => post("/api/billing/cancel", { action: "cancel" }, "cancel")}
            >
              {busy === "cancel" ? <span className="spinner" /> : null}
              Oui, annuler le renouvellement
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirming(false)}>
              Garder mon abonnement
            </button>
          </div>
        </div>
      )}

      {feedback && <div className={`alert alert-${feedback.tone}`}>{feedback.text}</div>}
    </div>
  );
}

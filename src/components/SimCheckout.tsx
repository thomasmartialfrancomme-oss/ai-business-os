"use client";

import { useState } from "react";
import { SIM_TEST_CARDS } from "@/lib/sim-cards";

/**
 * Choix du scénario de paiement (simulation).
 *
 * Le corps envoyé au serveur ne contient AUCUNE donnée de carte : uniquement
 * l'identifiant du scénario. C'est le serveur qui fabrique puis délivre les
 * webhooks signés, et la page de retour qui constate l'état enregistré.
 */
export function SimCheckout({
  sessionId,
  status,
  alreadyPaid,
  email,
}: {
  sessionId: string;
  status: string;
  alreadyPaid: boolean;
  email: string;
}) {
  const [outcome, setOutcome] = useState<keyof typeof SIM_TEST_CARDS>("success");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; events: string[] } | null>(null);

  const scenarios: Array<{ key: keyof typeof SIM_TEST_CARDS; server: string; label: string }> = [
    { key: "success", server: "success", label: SIM_TEST_CARDS.success.label },
    { key: "declined", server: "declined", label: SIM_TEST_CARDS.declined.label },
    { key: "insufficientFunds", server: "insufficient_funds", label: SIM_TEST_CARDS.insufficientFunds.label },
    { key: "requiresAuth", server: "requires_action", label: SIM_TEST_CARDS.requiresAuth.label },
  ];

  async function pay() {
    setBusy(true);
    setResult(null);
    try {
      const selected = scenarios.find((scenario) => scenario.key === outcome)!;
      const response = await fetch(`/api/sim/checkout/${sessionId}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Aucun numéro de carte : uniquement le scénario choisi.
        body: JSON.stringify({ outcome: selected.server, card: SIM_TEST_CARDS[outcome].number.replace(/\s/g, "") }),
      });
      const data = (await response.json()) as Record<string, unknown>;
      const events = ((data.events as Array<{ type: string }>) ?? []).map((event) => event.type);
      if (!response.ok) {
        setResult({ ok: false, message: String(data.message ?? "Paiement refusé."), events });
        return;
      }
      setResult({ ok: selected.server === "success", message: String(data.message), events });

      if (selected.server === "success") {
        // Redirection vers la page de retour : elle ne fait que LIRE l'état écrit par le webhook.
        setTimeout(() => {
          window.location.href = `/billing/success?session_id=${encodeURIComponent(sessionId)}`;
        }, 1200);
      }
    } finally {
      setBusy(false);
    }
  }

  if (alreadyPaid) {
    return (
      <div className="stack">
        <div className="alert alert-success">
          Cette session a déjà été payée. Les événements Stripe correspondants ont été livrés au webhook.
        </div>
        <a className="btn btn-primary" href={`/billing/success?session_id=${encodeURIComponent(sessionId)}`}>
          Continuer vers la vérification du paiement
        </a>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="dim">
        Statut de la session : <span className="mono">{status}</span>
        {email ? (
          <>
            {" "}
            — client : <span className="mono">{email}</span>
          </>
        ) : null}
      </div>

      <div className="stack" style={{ gap: 8 }}>
        {scenarios.map((scenario) => (
          <label
            key={scenario.key}
            className={`card card-tight row ${outcome === scenario.key ? "card-highlight" : ""}`}
            style={{ gap: 12, cursor: "pointer", padding: 13 }}
          >
            <input
              type="radio"
              name="scenario"
              checked={outcome === scenario.key}
              onChange={() => setOutcome(scenario.key)}
              style={{ width: "auto" }}
            />
            <span className="grow">
              <strong>{scenario.label}</strong>
              <div className="mono dim">{SIM_TEST_CARDS[scenario.key].number}</div>
            </span>
            {scenario.server === "requires_action" && <span className="badge badge-warning">3D Secure</span>}
          </label>
        ))}
      </div>

      <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={pay}>
        {busy ? <span className="spinner" /> : null}
        Payer et déclencher les webhooks Stripe
      </button>

      {result && (
        <div className={`alert alert-${result.ok ? "success" : "danger"}`}>
          <strong>{result.message}</strong>
          {result.events.length > 0 && <div className="mono mt-2">{result.events.join(" · ")}</div>}
        </div>
      )}
    </div>
  );
}

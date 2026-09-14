"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

interface StatusPayload {
  planCode: string | null;
  status: string | null;
  interval: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  lastPaymentStatus: string | null;
  access: { allowed: boolean; reason: string; accessUntil: string | null };
  checkedAt: string;
}

/**
 * ⚠️ PAGE DE RETOUR DE CHECKOUT — LE CŒUR DE LA RÈGLE ABSOLUE
 *
 * Ce composant N'ÉCRIT RIEN. Il interroge une route en LECTURE SEULE
 * (/api/billing/subscription/status) qui renvoie l'état réellement stocké,
 * lequel ne peut être écrit que par le webhook Stripe vérifié.
 *
 * Conséquence : arriver sur cette page ne signifie jamais « payé ».
 * Tant que le webhook n'a pas été traité, l'écran affiche « en attente ».
 */
export function SuccessPoller({ sessionId }: { sessionId: string | null }) {
  const [state, setState] = useState<StatusPayload | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const MAX_ATTEMPTS = 30; // ~60 s : le webhook arrive généralement en quelques secondes

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const response = await fetch("/api/billing/subscription/status", { cache: "no-store" });
        if (!response.ok) {
          setError("Impossible de lire l'état de l'abonnement (session expirée ?).");
          return;
        }
        const data = (await response.json()) as StatusPayload;
        if (cancelled) return;
        setState(data);

        const settled = Boolean(
          data.access?.allowed ||
            ["ACTIVE", "TRIALING", "CANCELED", "UNPAID", "INCOMPLETE_EXPIRED"].includes(data.status ?? "")
        );
        if (!settled && attempts < MAX_ATTEMPTS) {
          timer.current = setTimeout(() => setAttempts((value) => value + 1), 2000);
        }
      } catch {
        if (!cancelled) setError("Erreur réseau pendant la vérification.");
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [attempts]);

  const accessGranted = Boolean(state?.access?.allowed);
  const waiting = !accessGranted && attempts < MAX_ATTEMPTS && !error;
  const timedOut = !accessGranted && attempts >= MAX_ATTEMPTS;

  return (
    <div className="card card-highlight">
      {waiting && (
        <div className="stack">
          <div className="row">
            <span className="spinner" />
            <h3 style={{ margin: 0 }}>Vérification du paiement auprès de Stripe…</h3>
          </div>
          <p className="muted">
            Votre paiement a bien été transmis. L'abonnement s'active automatiquement dès réception de la confirmation
            signée de Stripe (webhook). Cette page ne fait que constater l'état enregistré par le serveur.
          </p>
          <div className="dim">
            Session : <span className="mono">{sessionId ?? "inconnue"}</span> — tentative {attempts + 1}/{MAX_ATTEMPTS}
          </div>
        </div>
      )}

      {accessGranted && (
        <div className="stack">
          <div className="row-between">
            <h3 style={{ margin: 0 }}>Abonnement activé 🎉</h3>
            <span className="badge badge-success">Accès accordé</span>
          </div>
          <p className="muted">
            La confirmation Stripe a été reçue et vérifiée. Votre abonnement{" "}
            <strong>{state?.planCode}</strong> ({state?.interval === "YEAR" ? "annuel" : "mensuel"}) est actif
            jusqu'au <strong>{state?.currentPeriodEnd ? new Date(state.currentPeriodEnd).toLocaleDateString("fr-FR") : "—"}</strong>.
          </p>
          <div className="btn-group">
            <Link href="/billing" className="btn btn-primary">
              Ouvrir mon espace facturation
            </Link>
            <Link href="/" className="btn btn-ghost">
              Accéder à AI Business OS
            </Link>
          </div>
        </div>
      )}

      {timedOut && (
        <div className="stack">
          <h3 style={{ margin: 0 }}>Paiement en cours de vérification</h3>
          <p className="muted">
            Nous n'avons pas encore reçu la confirmation de Stripe. Cela peut prendre quelques minutes pour certains
            moyens de paiement. Aucun accès n'est accordé tant que la confirmation n'est pas arrivée : rechargez la page
            ou ouvrez votre espace facturation.
          </p>
          <div className="btn-group">
            <button type="button" className="btn btn-primary" onClick={() => setAttempts(0)}>
              Revérifier maintenant
            </button>
            <Link href="/billing" className="btn btn-ghost">
              Espace facturation
            </Link>
          </div>
        </div>
      )}

      {error && (
        <div className="stack">
          <h3 style={{ margin: 0 }}>Vérification impossible</h3>
          <p className="muted">{error}</p>
          <Link href="/billing" className="btn btn-primary">
            Ouvrir mon espace facturation
          </Link>
        </div>
      )}

      {state && (
        <div className="divider" />
      )}
      {state && (
        <p className="dim" style={{ marginBottom: 0 }}>
          État lu en base à {new Date(state.checkedAt).toLocaleTimeString("fr-FR")} — statut d'abonnement :{" "}
          <span className="mono">{state.status ?? "aucun"}</span>, dernier paiement :{" "}
          <span className="mono">{state.lastPaymentStatus ?? "—"}</span>.
        </p>
      )}
    </div>
  );
}

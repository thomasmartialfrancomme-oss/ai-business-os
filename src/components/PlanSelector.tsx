"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatMoney } from "@/lib/format";

export interface PlanCardData {
  code: string;
  name: string;
  tagline: string;
  features: string[];
  monthlyCents: number;
  yearlyCents: number;
  yearlyMonthlyEquivalent: number;
  currency: string;
  featured: boolean;
  stripePriceConfigured: boolean;
}

/**
 * Sélection du forfait et déclenchement des actions de paiement.
 *
 * Toutes les actions se contentent d'appeler nos routes serveur, qui :
 *  - recalculent le prix (le montant envoyé par le navigateur n'est jamais utilisé) ;
 *  - créent la session de paiement chez Stripe / la facture de virement.
 * Aucun état « payé » n'est jamais posé par ce composant.
 */
export function PlanSelector({
  plans,
  authenticated,
  hasActiveSubscription,
  currentPlan,
  currentInterval,
  annualDiscountPercent,
  initialPlan,
  simulation,
}: {
  plans: PlanCardData[];
  authenticated: boolean;
  hasActiveSubscription: boolean;
  currentPlan: string | null;
  currentInterval: string | null;
  annualDiscountPercent: number;
  initialPlan: string | null;
  simulation: boolean;
}) {
  const router = useRouter();
  const [interval, setInterval] = useState<"MONTH" | "YEAR">("MONTH");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);
  const [bankTransfer, setBankTransfer] = useState<{
    reference: string;
    amountCents: number;
    currency: string;
    iban: string;
    accountHolder: string;
    bankName: string;
    bic: string;
    note: string;
  } | null>(null);

  const yearlySaving = useMemo(() => {
    const starter = plans[0];
    if (!starter) return 0;
    return starter.monthlyCents * 12 - starter.yearlyCents;
  }, [plans]);

  async function call(path: string, body: Record<string, unknown>, label: string) {
    setBusy(label);
    setMessage(null);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        setMessage({ tone: "danger", text: String(data.message ?? "Action impossible.") });
        return null;
      }
      return data;
    } catch {
      setMessage({ tone: "danger", text: "Erreur réseau : l'action n'a pas abouti." });
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function subscribe(plan: PlanCardData) {
    if (!authenticated) {
      router.push("/login?next=/pricing");
      return;
    }
    const data = await call("/api/billing/checkout", { planCode: plan.code, interval }, "subscribe");
    if (data?.url) {
      setMessage({ tone: "info", text: "Redirection vers la page de paiement sécurisée…" });
      window.location.href = String(data.url);
    }
  }

  async function switchPlan(plan: PlanCardData) {
    const data = await call("/api/billing/plan", { planCode: plan.code, interval }, "switch");
    if (data) {
      setMessage({ tone: "success", text: String(data.message) });
      router.refresh();
    }
  }

  async function requestBankTransfer(plan: PlanCardData) {
    if (!authenticated) {
      router.push("/login?next=/pricing");
      return;
    }
    const data = await call("/api/billing/bank-transfer", { planCode: plan.code, interval }, "transfer");
    if (data) {
      setBankTransfer({
        reference: String(data.reference),
        amountCents: Number(data.amountCents),
        currency: String(data.currency),
        iban: String((data.bankDetails as { iban?: string })?.iban ?? ""),
        accountHolder: String((data.bankDetails as { accountHolder?: string })?.accountHolder ?? ""),
        bankName: String((data.bankDetails as { bankName?: string })?.bankName ?? ""),
        bic: String((data.bankDetails as { bic?: string })?.bic ?? ""),
        note: String((data.bankDetails as { note?: string })?.note ?? ""),
      });
      setMessage({
        tone: "info",
        text: "Facture de virement émise. Votre accès sera activé après réception effective des fonds.",
      });
    }
  }

  return (
    <div className="stack">
      <div className="row-between">
        <div className="switch" role="group" aria-label="Périodicité">
          <button type="button" className={interval === "MONTH" ? "active" : ""} onClick={() => setInterval("MONTH")}>
            Mensuel
          </button>
          <button type="button" className={interval === "YEAR" ? "active" : ""} onClick={() => setInterval("YEAR")}>
            Annuel − {annualDiscountPercent}%
          </button>
        </div>
        {interval === "YEAR" && (
          <span className="dim">
            Économie de {formatMoney(yearlySaving, plans[0]?.currency ?? "eur")} par an sur le forfait Starter.
          </span>
        )}
      </div>

      {message && <div className={`alert alert-${message.tone}`}>{message.text}</div>}

      {bankTransfer && (
        <div className="card card-warning">
          <div className="row-between">
            <h3>Coordonnées de virement</h3>
            <span className="badge badge-warning">En attente de virement</span>
          </div>
          <p className="dim">
            Facture {bankTransfer.reference} — montant à virer :{" "}
            <strong>{formatMoney(bankTransfer.amountCents, bankTransfer.currency)}</strong>. Indiquez la référence{" "}
            <strong>{bankTransfer.reference}</strong> en libellé du virement.
          </p>
          <dl className="kv">
            <dt>Titulaire</dt>
            <dd>{bankTransfer.accountHolder || "—"}</dd>
            <dt>Banque</dt>
            <dd>{bankTransfer.bankName || "—"}</dd>
            <dt>IBAN</dt>
            <dd className="mono">{bankTransfer.iban || "—"}</dd>
            <dt>BIC</dt>
            <dd className="mono">{bankTransfer.bic || "—"}</dd>
          </dl>
          {bankTransfer.note && <p className="dim mt-2">{bankTransfer.note}</p>}
          <a className="btn btn-sm mt-2" href="/billing">
            Suivre ma facture dans mon espace
          </a>
        </div>
      )}

      <div className="plans">
        {plans.map((plan) => {
          const isCurrent = currentPlan === plan.code && currentInterval === interval;
          const price = interval === "MONTH" ? plan.monthlyCents : plan.yearlyCents;
          return (
            <div key={plan.code} className={`card plan ${plan.featured ? "card-highlight" : ""}`}>
              {plan.featured && <span className="ribbon">Le plus choisi</span>}
              <div className="row-between">
                <h3>{plan.name}</h3>
                {isCurrent && <span className="badge badge-success">Forfait actuel</span>}
              </div>
              <p className="dim" style={{ minHeight: 42 }}>
                {plan.tagline}
              </p>
              <div className="plan-price">
                {formatMoney(price, plan.currency)}
                <small> / {interval === "MONTH" ? "mois" : "an"}</small>
              </div>
              {interval === "YEAR" && (
                <div className="dim">
                  soit {formatMoney(plan.yearlyMonthlyEquivalent, plan.currency)} / mois — 2 mois offerts environ
                </div>
              )}

              <ul className="plan-features">
                {plan.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>

              <div className="stack mt-2" style={{ gap: 8, marginTop: "auto" }}>
                {hasActiveSubscription ? (
                  <button
                    type="button"
                    className={`btn btn-block ${plan.featured ? "btn-primary" : ""}`}
                    disabled={busy !== null || isCurrent}
                    onClick={() => switchPlan(plan)}
                  >
                    {busy === "switch" ? <span className="spinner" /> : null}
                    {isCurrent ? "Forfait actuel" : `Passer à ${plan.name}`}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`btn btn-block ${plan.featured ? "btn-primary" : ""}`}
                    disabled={busy !== null}
                    onClick={() => subscribe(plan)}
                  >
                    {busy === "subscribe" ? <span className="spinner" /> : null}
                    S'abonner — carte bancaire
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-block btn-ghost btn-sm"
                  disabled={busy !== null || hasActiveSubscription}
                  onClick={() => requestBankTransfer(plan)}
                >
                  {busy === "transfer" ? <span className="spinner" /> : null}
                  Payer par virement bancaire
                </button>
              </div>

              {!plan.stripePriceConfigured && !simulation && (
                <p className="dim mt-2" style={{ marginBottom: 0 }}>
                  Aucun ID de prix Stripe configuré : lancez <span className="mono">npm run stripe:setup</span>.
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

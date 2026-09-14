import Link from "next/link";
import { notFound } from "next/navigation";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";
import { Alert, Badge, PaymentStatusBadge, SectionTitle, SubscriptionStatusBadge } from "@/components/ui";
import { formatDate, formatMoney } from "@/lib/format";
import { SimActions } from "@/components/SimActions";
import { SIM_TEST_CARDS } from "@/lib/sim-cards";

export const dynamic = "force-dynamic";

/**
 * /sim — panneau de simulation.
 *
 * Disponible UNIQUEMENT en mode simulation (aucune clé Stripe). Il permet de
 * déclencher les événements que seul Stripe peut produire : renouvellement,
 * échec de paiement, expiration de session. Chaque action génère de vrais
 * événements signés qui passent par /api/stripe/webhook.
 */
export default async function SimPage() {
  if (!env.simulationAllowed || env.stripeMode !== "simulation") notFound();

  const [subscriptions, openSessions, webhooks, audit] = await Promise.all([
    prisma.subscription.findMany({
      orderBy: { updatedAt: "desc" },
      include: { user: { select: { email: true, name: true } } },
      take: 20,
    }),
    prisma.simObject.findMany({ where: { type: "checkout_session" }, orderBy: { createdAt: "desc" }, take: 6 }),
    prisma.webhookEvent.findMany({ orderBy: { receivedAt: "desc" }, take: 12 }),
    prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 12 }),
  ]);

  return (
    <div className="container" style={{ paddingTop: 30 }}>
      <div className="row-between">
        <div>
          <h1>Panneau de simulation</h1>
          <p className="muted">
            Rejoue le rôle des serveurs Stripe : chaque action produit des webhooks <strong>signés</strong> livrés à{" "}
            <span className="mono">/api/stripe/webhook</span>, exactement comme en production.
          </p>
        </div>
        <Badge tone="badge-warning">Mode simulation</Badge>
      </div>

      <div className="mt-4">
        <Alert tone="info" title="Comment activer le mode réel">
          Ajoutez <span className="mono">STRIPE_SECRET_KEY=sk_test_…</span> dans <span className="mono">.env</span> puis
          redémarrez : cette page disparaît et les paiements passent par votre compte Stripe TEST (ou LIVE avec{" "}
          <span className="mono">sk_live_…</span>).
        </Alert>
      </div>

      <div className="grid grid-2 mt-6">
        <div className="card card-tight">
          <h3>Cartes de test utilisées</h3>
          <p className="dim mt-2">
            Les mêmes cartes de test que celles de Stripe : aucun numéro de carte réel n'est utilisé, et aucune donnée
            de carte n'est transmise à l'application (seule la décision de scénario est envoyée).
          </p>
          <div className="table-wrap mt-2">
            <table>
              <thead>
                <tr>
                  <th>Numéro</th>
                  <th>Scénario</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(SIM_TEST_CARDS).map(([key, card]) => (
                  <tr key={key}>
                    <td className="mono">{card.number}</td>
                    <td className="dim">{card.label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card card-tight">
          <h3>Sessions de paiement récentes</h3>
          <p className="dim mt-2">
            Une session reste « open » tant qu'aucun paiement n'a été accepté. Reprenez une session pour tester un
            refus, une authentification 3D Secure ou un succès.
          </p>
          <div className="stack mt-2" style={{ gap: 8 }}>
            {openSessions.map((session) => {
              const data = session.data as Record<string, unknown>;
              const metadata = (data.metadata as Record<string, string>) ?? {};
              return (
                <div key={session.id} className="row-between">
                  <div>
                    <div className="mono">{session.id}</div>
                    <div className="dim">
                      {metadata.plan_code ?? "—"} · {formatMoney(Number(data.amount_total ?? 0), String(data.currency ?? "eur"))}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    <span className={`badge ${data.status === "complete" ? "badge-success" : data.status === "expired" ? "badge-neutral" : "badge-warning"}`}>
                      {String(data.status ?? "open")}
                    </span>
                    <Link href={`/sim/checkout/${session.id}`} className="btn btn-sm">
                      Ouvrir
                    </Link>
                  </div>
                </div>
              );
            })}
            {openSessions.length === 0 && <span className="dim">Aucune session de paiement. Souscrivez depuis <Link href="/pricing">/pricing</Link>.</span>}
          </div>
        </div>
      </div>

      <SectionTitle>Abonnements — déclencher renouvellement ou échec</SectionTitle>
      <div className="stack">
        {subscriptions.map((subscription) => (
          <div key={subscription.id} className="card card-tight">
            <div className="row-between">
              <div>
                <strong>{subscription.user.name}</strong>
                <div className="dim">{subscription.user.email}</div>
              </div>
              <div className="row" style={{ gap: 12 }}>
                <div className="right">
                  <div>
                    {subscription.planCode} · {formatMoney(subscription.amountCents, subscription.currency)}
                  </div>
                  <div className="dim">renouvellement {formatDate(subscription.currentPeriodEnd)}</div>
                </div>
                <SubscriptionStatusBadge status={subscription.status} />
                <PaymentStatusBadge status={subscription.lastPaymentStatus?.toUpperCase() ?? null} />
              </div>
            </div>
            {subscription.stripeSubscriptionId ? (
              <SimActions
                subscriptionId={subscription.stripeSubscriptionId}
                cancelAtPeriodEnd={subscription.cancelAtPeriodEnd}
                status={subscription.status}
              />
            ) : (
              <p className="dim mt-2" style={{ marginBottom: 0 }}>
                Aucun abonnement Stripe associé (paiement non finalisé ou facture de virement).
              </p>
            )}
          </div>
        ))}
        {subscriptions.length === 0 && (
          <div className="card card-tight">
            <span className="dim">Aucun abonnement enregistré.</span>
          </div>
        )}
      </div>

      <div className="grid grid-2 mt-6">
        <div className="card card-tight">
          <h3>Webhooks reçus</h3>
          <div className="table-wrap mt-2">
            <table>
              <thead>
                <tr>
                  <th>Événement</th>
                  <th>Type</th>
                  <th>Statut</th>
                </tr>
              </thead>
              <tbody>
                {webhooks.map((event) => (
                  <tr key={event.stripeEventId}>
                    <td className="mono" style={{ fontSize: 11.5 }}>
                      {event.stripeEventId.slice(0, 20)}…
                    </td>
                    <td className="dim mono">{event.type}</td>
                    <td>
                      <span className={`badge ${event.status === "PROCESSED" ? "badge-success" : event.status === "FAILED" ? "badge-danger" : "badge-neutral"}`}>
                        {event.status}
                      </span>
                    </td>
                  </tr>
                ))}
                {webhooks.length === 0 && (
                  <tr>
                    <td colSpan={3} className="dim">
                      Aucun webhook reçu.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card card-tight">
          <h3>Journal d'audit</h3>
          <div className="stack mt-2" style={{ gap: 6 }}>
            {audit.map((entry) => (
              <div key={entry.id} className="row-between">
                <span className="mono">{entry.action}</span>
                <span className="dim">{formatDate(entry.createdAt, true)}</span>
              </div>
            ))}
            {audit.length === 0 && <span className="dim">Journal vide.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

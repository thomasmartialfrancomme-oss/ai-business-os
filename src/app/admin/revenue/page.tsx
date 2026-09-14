import Link from "next/link";
import { requireOwner } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { computeRevenueMetrics, platformBalance } from "@/lib/payments/metrics";
import { webhookHealth } from "@/lib/payments/webhook";
import { Alert, Badge, BarChart, PaymentStatusBadge, SectionTitle, Stat, SubscriptionStatusBadge } from "@/components/ui";
import { daysUntil, formatDate, formatMoney, PAYMENT_METHOD_LABELS } from "@/lib/format";
import { AdminBankTransferConfirm } from "@/components/AdminBankTransferConfirm";
import { AdminRefund } from "@/components/AdminRefund";

export const dynamic = "force-dynamic";

/**
 * /admin/revenue — tableau de bord du propriétaire de la plateforme.
 *
 * Répond à trois questions :
 *   1. combien la plateforme encaisse-t-elle (mois, total, MRR, ARR) ?
 *   2. où en sont les abonnements (actifs, nouveaux, annulations, échecs) ?
 *   3. où est l'argent (solde Stripe, virements programmés, virements en attente) ?
 */
export default async function AdminRevenuePage() {
  const owner = await requireOwner("/admin/revenue");

  const [metrics, balance, health, subscriptions, awaitingTransfers, failedPayments, recentPayments, auditTail] =
    await Promise.all([
      computeRevenueMetrics(),
      platformBalance(),
      webhookHealth(),
      prisma.subscription.findMany({
        orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
        include: { user: { select: { email: true, name: true } } },
        take: 12,
      }),
      prisma.invoice.findMany({
        where: { status: "AWAITING_BANK_TRANSFER" },
        orderBy: { createdAt: "asc" },
        include: { user: { select: { email: true, name: true } } },
      }),
      prisma.payment.findMany({ where: { status: "FAILED" }, orderBy: { createdAt: "desc" }, take: 6 }),
      prisma.payment.findMany({ orderBy: { createdAt: "desc" }, take: 8, include: { user: { select: { email: true } } } }),
      prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 10 }),
    ]);

  const currency = metrics.currency;

  return (
    <div className="container" style={{ paddingTop: 30 }}>
      <div className="row-between">
        <div>
          <h1>Revenus & abonnements</h1>
          <p className="muted">
            Propriétaire : {owner.email} — données issues des webhooks Stripe vérifiés.
          </p>
        </div>
        <div className="row">
          <Badge tone={env.stripeMode === "live" ? "badge-success" : env.stripeMode === "test" ? "badge-info" : "badge-warning"}>
            Stripe {env.stripeMode === "live" ? "LIVE" : env.stripeMode === "test" ? "TEST" : "simulation"}
          </Badge>
          <Link href="/admin/settings" className="btn btn-sm">
            Paramètres bancaires
          </Link>
        </div>
      </div>

      <SectionTitle>Indicateurs clés</SectionTitle>
      <div className="grid grid-stats">
        <Stat label="Revenus du mois" value={formatMoney(metrics.monthRevenueCents, currency)} hint={`Remboursements : ${formatMoney(metrics.monthRefundedCents, currency)}`} />
        <Stat label="Revenus totaux" value={formatMoney(metrics.totalRevenueCents, currency)} hint={`depuis le lancement — remb. ${formatMoney(metrics.totalRefundedCents, currency)}`} />
        <Stat label="Abonnements actifs" value={metrics.activeSubscriptions} hint={`${metrics.trialingSubscriptions} en essai`} />
        <Stat label="Nouveaux abonnements" value={metrics.newSubscriptionsThisMonth} hint="sur le mois en cours" tone="success" />
        <Stat label="Annulations" value={metrics.cancellationsThisMonth} hint={`${metrics.scheduledCancellations} en fin de période`} tone={metrics.cancellationsThisMonth > 0 ? "warning" : undefined} />
        <Stat label="Paiements échoués" value={metrics.failedPaymentsThisMonth} hint={`${metrics.pastDueSubscriptions} abonnement(s) en retard`} tone={metrics.failedPaymentsThisMonth > 0 ? "danger" : undefined} />
        <Stat label="MRR" value={formatMoney(metrics.mrrCents, currency)} hint={`dont ${formatMoney(metrics.mrrAtRiskCents, currency)} à risque (past_due)`} />
        <Stat label="ARR estimé" value={formatMoney(metrics.arrCents, currency)} hint={`ARPU ${formatMoney(metrics.arpuCents, currency)}`} />
      </div>

      <div className="grid grid-2 mt-6">
        <div className="card">
          <div className="row-between">
            <h3>Encaissements des 6 derniers mois</h3>
            <span className="dim">Montant net des remboursements</span>
          </div>
          <BarChart
            points={metrics.timeline.map((point) => ({
              label: point.label,
              value: point.revenueCents,
              caption: formatMoney(point.revenueCents, currency),
            }))}
          />
        </div>

        <div className="card">
          <div className="row-between">
            <h3>Solde Stripe du propriétaire</h3>
            <span className="dim">Versement automatique</span>
          </div>
          {balance ? (
            <div className="stack mt-2" style={{ gap: 10 }}>
              <div className="grid grid-2" style={{ gap: 10 }}>
                <Stat label="Solde disponible" value={formatMoney(balance.availableCents, balance.defaultCurrency ?? currency)} hint="prêt à être versé" />
                <Stat label="En attente" value={formatMoney(balance.pendingCents, balance.defaultCurrency ?? currency)} hint="encore en traitement" />
              </div>
              <dl className="kv">
                <dt>Compte</dt>
                <dd>
                  {balance.country ?? "—"} — {balance.defaultCurrency?.toUpperCase() ?? "—"}{" "}
                  {balance.chargesEnabled ? "· encaissement actif" : "· encaissement désactivé"}{" "}
                  {balance.payoutsEnabled ? "· virements actifs" : "· virements désactivés"}
                </dd>
                <dt>Cadence des virements</dt>
                <dd>{balance.payoutSchedule ?? "selon les paramètres du compte Stripe"}</dd>
                <dt>Compte bancaire</dt>
                <dd>
                  {balance.bankAccounts.length > 0
                    ? balance.bankAccounts
                        .map((account) => `${account.bankName ?? "banque"} ••••${account.last4 ?? "????"}${account.default ? " (par défaut)" : ""}`)
                        .join(", ")
                    : "Aucun compte bancaire associé au compte Stripe"}
                </dd>
              </dl>
              <Alert tone="info">
                Les fonds sont encaissés sur votre compte Stripe, puis versés automatiquement sur le compte bancaire
                configuré <strong>dans Stripe</strong>. Aucun IBAN de versement n'est stocké dans cette application :
                la configuration se fait dans votre tableau de bord Stripe, onglet « Virements ».
              </Alert>
            </div>
          ) : (
            <Alert tone="warning" title="Solde indisponible">
              Impossible de lire le compte Stripe (mode simulation ou clé absente/insuffisante). Ajoutez une clé{" "}
              <span className="mono">sk_test_…</span> ou <span className="mono">sk_live_…</span> pour voir le solde réel et le
              compte bancaire associé.
            </Alert>
          )}
        </div>
      </div>

      <SectionTitle
        aside={
          <span className="dim">
            {metrics.awaitingBankTransfer} virement(s) en attente —{" "}
            {formatMoney(metrics.awaitingBankTransferCents, currency)}
          </span>
        }
      >
        Virements bancaires à confirmer
      </SectionTitle>
      {awaitingTransfers.length > 0 ? (
        <div className="stack">
          {awaitingTransfers.map((invoice) => (
            <div key={invoice.id} className="card card-warning card-tight">
              <div className="row-between">
                <div>
                  <strong className="mono">{invoice.bankTransferReference}</strong>
                  <div className="dim">
                    {invoice.user.name} ({invoice.user.email}) — {invoice.planCode}{" "}
                    {invoice.interval === "YEAR" ? "annuel" : "mensuel"}
                  </div>
                </div>
                <div className="right">
                  <div>{formatMoney(invoice.amountDue, invoice.currency)}</div>
                  <div className="dim">
                    {invoice.bankTransferDeclaredAt
                      ? `virement déclaré le ${formatDate(invoice.bankTransferDeclaredAt, true)}`
                      : "aucune déclaration du client"}
                  </div>
                </div>
              </div>
              {invoice.bankTransferNote && <p className="dim mt-2">Note client : {invoice.bankTransferNote}</p>}
              <AdminBankTransferConfirm
                invoiceId={invoice.id}
                reference={invoice.bankTransferReference ?? ""}
                amountLabel={formatMoney(invoice.amountDue, invoice.currency)}
                mode={env.stripeMode}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="card card-tight">
          <span className="dim">
            Aucun virement en attente. Les factures émises en virement apparaissent ici jusqu'à confirmation du
            paiement.
          </span>
        </div>
      )}

      <SectionTitle>Abonnements</SectionTitle>
      <div className="card card-tight">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Plan</th>
                <th>Statut</th>
                <th>Période</th>
                <th>Montant</th>
                <th>Renouvellement</th>
                <th>Dernier paiement</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((subscription) => {
                const days = daysUntil(subscription.currentPeriodEnd);
                return (
                  <tr key={subscription.id}>
                    <td>
                      {subscription.user.name}
                      <div className="dim">{subscription.user.email}</div>
                    </td>
                    <td>
                      {subscription.planCode}
                      <div className="dim">{subscription.interval === "YEAR" ? "annuel" : "mensuel"}</div>
                    </td>
                    <td>
                      <SubscriptionStatusBadge status={subscription.status} />
                      {subscription.cancelAtPeriodEnd && <div className="dim">fin de période</div>}
                    </td>
                    <td className="dim nowrap">
                      {formatDate(subscription.currentPeriodStart)} → {formatDate(subscription.currentPeriodEnd)}
                    </td>
                    <td className="nowrap">{formatMoney(subscription.amountCents, subscription.currency)}</td>
                    <td className="dim nowrap">
                      {subscription.cancelAtPeriodEnd ? "non renouvelé" : days !== null ? `dans ${days} j` : "—"}
                    </td>
                    <td>
                      <PaymentStatusBadge status={subscription.lastPaymentStatus?.toUpperCase() ?? null} />
                      <div className="dim">{formatDate(subscription.lastPaymentAt)}</div>
                    </td>
                  </tr>
                );
              })}
              {subscriptions.length === 0 && (
                <tr>
                  <td colSpan={7} className="dim">
                    Aucun abonnement.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-2 mt-6">
        <div className="card card-tight">
          <div className="row-between">
            <h3>Derniers paiements</h3>
            <Badge tone={health.failed > 0 ? "badge-danger" : "badge-success"}>
              {health.failed} webhook(s) en échec / {health.total}
            </Badge>
          </div>
          <div className="table-wrap mt-2">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Client</th>
                  <th>Montant</th>
                  <th>Statut</th>
                  <th className="right">Action</th>
                </tr>
              </thead>
              <tbody>
                {recentPayments.map((payment) => (
                  <tr key={payment.id}>
                    <td className="nowrap">{formatDate(payment.createdAt)}</td>
                    <td className="dim">{payment.user.email}</td>
                    <td className="nowrap">{formatMoney(payment.amount, payment.currency)}</td>
                    <td>
                      <PaymentStatusBadge status={payment.status} />
                      <div className="dim">{PAYMENT_METHOD_LABELS[payment.method]}</div>
                    </td>
                    <td className="right">
                      {payment.status === "SUCCEEDED" && payment.method === "CARD" && payment.stripePaymentIntentId ? (
                        <AdminRefund paymentIntentId={payment.stripePaymentIntentId} amountLabel={formatMoney(payment.amount, payment.currency)} />
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                  </tr>
                ))}
                {recentPayments.length === 0 && (
                  <tr>
                    <td colSpan={5} className="dim">
                      Aucun paiement.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card card-tight">
          <h3>Incidents à traiter</h3>
          <div className="stack mt-2" style={{ gap: 8 }}>
            <div className="row-between">
              <span className="dim">Paiements échoués (récents)</span>
              <strong>{failedPayments.length}</strong>
            </div>
            {failedPayments.map((payment) => (
              <div key={payment.id} className="row-between">
                <span className="dim">
                  {formatDate(payment.createdAt)} — <span className="mono">{payment.stripePaymentIntentId ?? payment.id}</span>
                </span>
                <span className="badge badge-danger">{payment.failureCode ?? "échec"}</span>
              </div>
            ))}
            <div className="divider" />
            <div className="row-between">
              <span className="dim">Dernier webhook</span>
              <span className="mono">
                {health.lastType ?? "—"} · {formatDate(health.lastReceivedAt, true)}
              </span>
            </div>
            <div className="row-between">
              <span className="dim">Événements ignorés (doublons, non traités)</span>
              <strong>{health.duplicates}</strong>
            </div>
          </div>
        </div>
      </div>

      <SectionTitle>Journal d'audit (10 derniers mouvements)</SectionTitle>
      <div className="card card-tight">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Horodatage</th>
                <th>Acteur</th>
                <th>Action</th>
                <th>Cible</th>
              </tr>
            </thead>
            <tbody>
              {auditTail.map((entry) => (
                <tr key={entry.id}>
                  <td className="nowrap dim">{formatDate(entry.createdAt, true)}</td>
                  <td>
                    <span className="badge badge-neutral">{entry.actorType}</span>
                  </td>
                  <td className="mono">{entry.action}</td>
                  <td className="dim mono">{entry.targetType ? `${entry.targetType} · ${entry.targetId ?? "—"}` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

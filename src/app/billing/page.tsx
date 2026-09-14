import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { hasAccess, ACCESS_REASON_LABELS } from "@/lib/access";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { PLANS, formatMoney } from "@/lib/plans";
import { Alert, Badge, PaymentStatusBadge, SectionTitle, SubscriptionStatusBadge } from "@/components/ui";
import { formatDate, daysUntil, INTERVAL_LABELS, PAYMENT_METHOD_LABELS } from "@/lib/format";
import { BillingActions } from "@/components/BillingActions";
import { PendingBankTransfer } from "@/components/PendingBankTransfer";

export const dynamic = "force-dynamic";

/**
 * /billing — espace facturation du client.
 *
 * Tout ce qui est affiché ici provient de la base, elle-même écrite exclusivement
 * par les webhooks Stripe. Le bouton « Synchroniser » relit l'état à la source :
 * il ne peut jamais inventer un paiement réussi.
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; forbidden?: string; sim_portal?: string }>;
}) {
  const params = await searchParams;
  const user = await requireUser("/billing");

  const [subscription, invoices, payments, awaitingTransfer, recentWebhooks] = await Promise.all([
    prisma.subscription.findUnique({ where: { userId: user.id } }),
    prisma.invoice.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 8 }),
    prisma.payment.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" }, take: 6 }),
    prisma.invoice.findFirst({ where: { userId: user.id, status: "AWAITING_BANK_TRANSFER" }, orderBy: { createdAt: "desc" } }),
    prisma.webhookEvent.findMany({ orderBy: { receivedAt: "desc" }, take: 4, select: { type: true, receivedAt: true, status: true } }),
  ]);

  const access = hasAccess(subscription);
  const plan = subscription ? PLANS[subscription.planCode as keyof typeof PLANS] : null;
  const nextPaymentDate = subscription?.currentPeriodEnd ?? null;
  const days = daysUntil(nextPaymentDate);

  return (
    <div className="container" style={{ paddingTop: 30 }}>
      <div className="row-between">
        <div>
          <h1>Espace facturation</h1>
          <p className="muted">
            {user.name} — {user.email}
          </p>
        </div>
        <div className="row">
          <Badge tone={access.allowed ? "badge-success" : "badge-warning"}>
            {access.allowed ? "Accès AI Business OS actif" : "Accès suspendu"}
          </Badge>
          {env.simulationAllowed && env.stripeMode === "simulation" && <Badge tone="badge-warning">Simulation</Badge>}
        </div>
      </div>

      {params.forbidden && (
        <div className="mt-4">
          <Alert tone="warning" title="Accès réservé">
            Cette page est réservée au propriétaire de la plateforme.
          </Alert>
        </div>
      )}

      {!subscription && (
        <div className="mt-6">
          <Alert tone="info" title="Aucun abonnement">
            Vous n'avez pas encore d'abonnement.{" "}
            <Link href="/pricing">Choisissez un forfait</Link> pour accéder à AI Business OS.
          </Alert>
        </div>
      )}

      {subscription && (
        <>
          {subscription.status === "PAST_DUE" && (
            <div className="mt-4">
              <Alert tone="warning" title="Paiement en échec">
                Le dernier paiement a échoué{subscription.lastFailureMessage ? ` : ${subscription.lastFailureMessage}` : "."} Stripe
                relance le prélèvement automatiquement. Votre accès reste ouvert
                {access.accessUntil ? ` jusqu'au ${formatDate(access.accessUntil)}` : " pendant la période de grâce"}. Mettez à jour votre
                moyen de paiement pour éviter toute suspension.
              </Alert>
            </div>
          )}

          <div className="grid grid-3 mt-6">
            <div className="card">
              <div className="stat-label">Plan actuel</div>
              <div className="stat-value">{plan?.name ?? subscription.planCode}</div>
              <div className="row mt-2" style={{ gap: 8 }}>
                <SubscriptionStatusBadge status={subscription.status} />
                <span className="dim">{INTERVAL_LABELS[subscription.interval]}</span>
              </div>
            </div>

            <div className="card">
              <div className="stat-label">Prix</div>
              <div className="stat-value">
                {formatMoney(subscription.amountCents, subscription.currency)}
                <span className="dim" style={{ fontSize: 14, fontWeight: 500 }}>
                  {" "}
                  / {subscription.interval === "YEAR" ? "an" : "mois"}
                </span>
              </div>
              <div className="stat-hint">
                {subscription.interval === "YEAR" && plan
                  ? `soit ${formatMoney(Math.round(subscription.amountCents / 12), subscription.currency)} / mois`
                  : "Renouvellement automatique"}
              </div>
            </div>

            <div className="card">
              <div className="stat-label">
                {subscription.cancelAtPeriodEnd ? "Accès jusqu'au" : "Prochaine date de paiement"}
              </div>
              <div className="stat-value" style={{ fontSize: 20 }}>
                {formatDate(nextPaymentDate)}
              </div>
              <div className="stat-hint">
                {subscription.cancelAtPeriodEnd
                  ? "Résiliation programmée : plus aucun prélèvement"
                  : days !== null
                    ? `dans ${days} jour(s)`
                    : "—"}
              </div>
            </div>
          </div>

          <div className="grid grid-2 mt-4">
            <div className="card card-tight">
              <h3>Statut de l'abonnement</h3>
              <dl className="kv mt-2">
                <dt>Période en cours</dt>
                <dd>
                  {formatDate(subscription.currentPeriodStart)} → {formatDate(subscription.currentPeriodEnd)}
                </dd>
                <dt>Résiliation programmée</dt>
                <dd>{subscription.cancelAtPeriodEnd ? "Oui (fin de période)" : "Non"}</dd>
                <dt>Dernier paiement</dt>
                <dd className="row" style={{ gap: 8 }}>
                  <PaymentStatusBadge status={subscription.lastPaymentStatus?.toUpperCase() ?? null} />
                  <span className="dim">{formatDate(subscription.lastPaymentAt, true)}</span>
                </dd>
                <dt>Accès au service</dt>
                <dd>
                  {ACCESS_REASON_LABELS[access.reason]}
                  {access.graceDaysRemaining !== null ? ` (${access.graceDaysRemaining} jour(s) restant(s))` : ""}
                </dd>
                <dt>Identifiant Stripe</dt>
                <dd className="mono">{subscription.stripeSubscriptionId ?? "—"}</dd>
              </dl>
            </div>

            <div className="card card-tight">
              <h3>Actions</h3>
              <p className="dim mt-2">
                Le changement de forfait et la mise à jour du moyen de paiement passent par notre serveur puis par
                Stripe. Aucune donnée de carte n'est saisie sur cette page.
              </p>
              <div className="btn-group mt-2">
                <Link href="/pricing" className="btn btn-sm btn-primary">
                  Changer de forfait
                </Link>
                <BillingActions
                  cancelAtPeriodEnd={subscription.cancelAtPeriodEnd}
                  hasStripeSubscription={Boolean(subscription.stripeSubscriptionId)}
                  mode={env.stripeMode}
                />
                <Link href="/billing/invoices" className="btn btn-sm btn-ghost">
                  Voir mes factures
                </Link>
              </div>
              {params.sim_portal === "1" && (
                <p className="dim mt-2" style={{ marginBottom: 0 }}>
                  Mode simulation : le portail de facturation Stripe n'existe pas. La gestion du moyen de paiement est
                  représentée par cette page ; avec une clé Stripe, le bouton ouvre le portail hébergé par Stripe.
                </p>
              )}
            </div>
          </div>
        </>
      )}

      {awaitingTransfer && <PendingBankTransfer invoiceId={awaitingTransfer.id} reference={awaitingTransfer.bankTransferReference ?? ""} amountDue={awaitingTransfer.amountDue} currency={awaitingTransfer.currency} declared={Boolean(awaitingTransfer.bankTransferDeclaredAt)} />}

      <SectionTitle
        aside={
          <Link href="/billing/invoices" className="btn btn-sm btn-ghost">
            Tout l'historique
          </Link>
        }
      >
        Historique des paiements et factures
      </SectionTitle>

      <div className="card card-tight">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Facture</th>
                <th>Montant</th>
                <th>Moyen</th>
                <th>Statut</th>
                <th className="right">Documents</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td className="nowrap">{formatDate(invoice.createdAt)}</td>
                  <td>
                    <span className="mono">{invoice.number ?? invoice.stripeInvoiceId ?? invoice.id}</span>
                    <div className="dim">{invoice.planCode ? `${invoice.planCode} — ${INTERVAL_LABELS[invoice.interval ?? "MONTH"]}` : "—"}</div>
                  </td>
                  <td className="nowrap">{formatMoney(invoice.amountDue, invoice.currency)}</td>
                  <td className="dim nowrap">{PAYMENT_METHOD_LABELS[invoice.paymentMethod]}</td>
                  <td>
                    <span className={`badge ${invoice.status === "PAID" ? "badge-success" : invoice.status === "AWAITING_BANK_TRANSFER" ? "badge-warning" : "badge-neutral"}`}>
                      {invoice.status === "PAID"
                        ? "Payée"
                        : invoice.status === "AWAITING_BANK_TRANSFER"
                          ? "Attente virement"
                          : invoice.status === "OPEN"
                            ? "En attente"
                            : invoice.status}
                    </span>
                  </td>
                  <td className="right nowrap">
                    {invoice.invoicePdfUrl ? (
                      <a className="btn btn-sm btn-ghost" href={invoice.invoicePdfUrl} target="_blank" rel="noreferrer">
                        PDF
                      </a>
                    ) : (
                      <span className="dim">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {invoices.length === 0 && (
                <tr>
                  <td colSpan={6} className="dim">
                    Aucune facture pour le moment.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-2 mt-4">
        <div className="card card-tight">
          <h3>Paiements</h3>
          <div className="table-wrap mt-2">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Montant</th>
                  <th>Moyen</th>
                  <th>Statut</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.id}>
                    <td className="nowrap">{formatDate(payment.createdAt)}</td>
                    <td className="nowrap">
                      {formatMoney(payment.amount, payment.currency)}
                      {payment.amountRefunded > 0 && <div className="dim">remb. {formatMoney(payment.amountRefunded, payment.currency)}</div>}
                    </td>
                    <td className="dim nowrap">{PAYMENT_METHOD_LABELS[payment.method]}</td>
                    <td>
                      <PaymentStatusBadge status={payment.status} />
                      {payment.failureCode && <div className="dim mono">{payment.failureCode}</div>}
                    </td>
                  </tr>
                ))}
                {payments.length === 0 && (
                  <tr>
                    <td colSpan={4} className="dim">
                      Aucun paiement enregistré.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card card-tight">
          <h3>Traçabilité (derniers webhooks)</h3>
          <p className="dim mt-2">
            Chaque changement d'état provient d'un événement Stripe signé. Ces événements passent tous par
            <span className="mono"> /api/stripe/webhook</span>.
          </p>
          <div className="stack" style={{ gap: 8 }}>
            {recentWebhooks.map((event) => (
              <div key={`${event.type}-${event.receivedAt.toISOString()}`} className="row-between">
                <span className="mono">{event.type}</span>
                <span className="row" style={{ gap: 8 }}>
                  <span className="dim">{formatDate(event.receivedAt, true)}</span>
                  <span className={`badge ${event.status === "PROCESSED" ? "badge-success" : event.status === "FAILED" ? "badge-danger" : "badge-neutral"}`}>
                    {event.status}
                  </span>
                </span>
              </div>
            ))}
            {recentWebhooks.length === 0 && <span className="dim">Aucun événement reçu pour l'instant.</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

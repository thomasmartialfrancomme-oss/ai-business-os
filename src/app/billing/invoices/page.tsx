import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { InvoiceStatusBadge, PaymentStatusBadge, Alert } from "@/components/ui";
import { formatDate, formatMoney, INTERVAL_LABELS, PAYMENT_METHOD_LABELS } from "@/lib/format";

export const dynamic = "force-dynamic";

/** /billing/invoices — historique complet des factures et paiements du client. */
export default async function InvoicesPage() {
  const user = await requireUser("/billing/invoices");

  const [invoices, payments] = await Promise.all([
    prisma.invoice.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      include: { payments: true },
    }),
    prisma.payment.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" } }),
  ]);

  const totalPaid = payments.filter((p) => p.status === "SUCCEEDED").reduce((sum, p) => sum + p.amount, 0);
  const totalRefunded = payments.reduce((sum, p) => sum + p.amountRefunded, 0);

  return (
    <div className="container" style={{ paddingTop: 30 }}>
      <div className="row-between">
        <div>
          <h1>Mes factures</h1>
          <p className="muted">
            {invoices.length} facture(s) — total encaissé {formatMoney(totalPaid, "eur")}
            {totalRefunded > 0 ? `, remboursé ${formatMoney(totalRefunded, "eur")}` : ""}.
          </p>
        </div>
        <Link href="/billing" className="btn btn-sm btn-ghost">
          ← Espace facturation
        </Link>
      </div>

      <div className="card card-tight mt-4">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Émise le</th>
                <th>Référence</th>
                <th>Période</th>
                <th>Montant</th>
                <th>Payé le</th>
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
                    <div className="dim">
                      {invoice.planCode ?? "—"} {invoice.interval ? `— ${INTERVAL_LABELS[invoice.interval]}` : ""}
                    </div>
                  </td>
                  <td className="dim nowrap">
                    {formatDate(invoice.periodStart)} → {formatDate(invoice.periodEnd)}
                  </td>
                  <td className="nowrap">
                    {formatMoney(invoice.amountDue, invoice.currency)}
                    {invoice.amountRefunded > 0 && (
                      <div className="dim">remb. {formatMoney(invoice.amountRefunded, invoice.currency)}</div>
                    )}
                  </td>
                  <td className="dim nowrap">{formatDate(invoice.paidAt)}</td>
                  <td className="dim nowrap">{PAYMENT_METHOD_LABELS[invoice.paymentMethod]}</td>
                  <td>
                    <InvoiceStatusBadge status={invoice.status} />
                    {invoice.bankTransferConfirmedBy && (
                      <div className="dim">confirmé par {invoice.bankTransferConfirmedBy}</div>
                    )}
                  </td>
                  <td className="right nowrap">
                    <div className="btn-group" style={{ justifyContent: "flex-end" }}>
                      {invoice.hostedInvoiceUrl && (
                        <a className="btn btn-sm btn-ghost" href={invoice.hostedInvoiceUrl} target="_blank" rel="noreferrer">
                          Page Stripe
                        </a>
                      )}
                      {invoice.invoicePdfUrl && (
                        <a className="btn btn-sm btn-ghost" href={invoice.invoicePdfUrl} target="_blank" rel="noreferrer">
                          PDF
                        </a>
                      )}
                      {!invoice.hostedInvoiceUrl && !invoice.invoicePdfUrl && <span className="dim">—</span>}
                    </div>
                  </td>
                </tr>
              ))}
              {invoices.length === 0 && (
                <tr>
                  <td colSpan={8} className="dim">
                    Aucune facture.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <h2 className="mt-6">Détail des paiements</h2>
      <div className="card card-tight">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Montant</th>
                <th>Moyen</th>
                <th>Identifiant Stripe</th>
                <th>Statut</th>
                <th>Motif d'échec</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id}>
                  <td className="nowrap">{formatDate(payment.createdAt, true)}</td>
                  <td className="nowrap">
                    {formatMoney(payment.amount, payment.currency)}
                    {payment.amountRefunded > 0 && (
                      <div className="dim">remboursé {formatMoney(payment.amountRefunded, payment.currency)}</div>
                    )}
                  </td>
                  <td className="dim nowrap">{PAYMENT_METHOD_LABELS[payment.method]}</td>
                  <td className="mono">{payment.stripePaymentIntentId ?? "—"}</td>
                  <td>
                    <PaymentStatusBadge status={payment.status} />
                  </td>
                  <td className="dim">{payment.failureMessage ?? "—"}</td>
                </tr>
              ))}
              {payments.length === 0 && (
                <tr>
                  <td colSpan={6} className="dim">
                    Aucun paiement enregistré.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4">
        <Alert tone="info" title="Données de carte">
          Aucun numéro de carte, aucun CVV et aucun code bancaire n'est stocké par AI Business OS : ces informations
          sont saisies et conservées exclusivement par Stripe. Les identifiants affichés ici (paiement, facture) sont
          des références opaques fournies par Stripe.
        </Alert>
      </div>
    </div>
  );
}

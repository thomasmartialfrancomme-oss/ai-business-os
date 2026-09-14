import { prisma } from "../db";
import { monthlyEquivalentCents, type BillingIntervalKey, type PlanCode } from "../plans";
import { getGateway } from ".";
import type { AccountStatus } from "./types";

/**
 * Indicateurs de revenus pour /admin/revenue.
 *
 * Toutes les valeurs sont calculées à partir de la base locale, elle-même écrite
 * uniquement par le pipeline de webhooks vérifiés : les chiffres affichés sont donc
 * réconciliables avec le tableau de bord Stripe (somme des paiements encaissés).
 */

export interface MonthPoint {
  key: string;
  label: string;
  revenueCents: number;
  newSubscriptions: number;
  cancellations: number;
}

export interface RevenueMetrics {
  currency: string;
  monthRevenueCents: number;
  monthRefundedCents: number;
  totalRevenueCents: number;
  totalRefundedCents: number;
  mrrCents: number;
  arrCents: number;
  mrrAtRiskCents: number;
  arpuCents: number;
  activeSubscriptions: number;
  trialingSubscriptions: number;
  pastDueSubscriptions: number;
  canceledSubscriptions: number;
  newSubscriptionsThisMonth: number;
  cancellationsThisMonth: number;
  scheduledCancellations: number;
  failedPaymentsThisMonth: number;
  awaitingBankTransfer: number;
  awaitingBankTransferCents: number;
  timeline: MonthPoint[];
}

function monthBounds(reference = new Date()): { start: Date; end: Date; key: string; label: string } {
  const start = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), 1));
  const end = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + 1, 1));
  return {
    start,
    end,
    key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
    label: start.toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }),
  };
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function computeRevenueMetrics(): Promise<RevenueMetrics> {
  const now = new Date();
  const { start: monthStart, end: monthEnd } = monthBounds(now);

  const [
    subscriptions,
    monthPayments,
    allPayments,
    monthInvoicesAwaiting,
    newSubscriptionsThisMonth,
    canceledThisMonthAudit,
  ] = await Promise.all([
    prisma.subscription.findMany({
      select: {
        planCode: true,
        interval: true,
        status: true,
        cancelAtPeriodEnd: true,
        currentPeriodStart: true,
        amountCents: true,
        currency: true,
      },
    }),
    prisma.payment.findMany({
      where: { status: { in: ["SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED"] }, createdAt: { gte: monthStart, lt: monthEnd } },
      select: { amount: true, amountRefunded: true, status: true, currency: true, createdAt: true },
    }),
    prisma.payment.findMany({
      where: { status: { in: ["SUCCEEDED", "REFUNDED", "PARTIALLY_REFUNDED"] } },
      select: { amount: true, amountRefunded: true, createdAt: true },
    }),
    prisma.invoice.findMany({
      where: { status: "AWAITING_BANK_TRANSFER" },
      select: { amountDue: true },
    }),
    prisma.subscription.count({
      where: {
        status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
        currentPeriodStart: { gte: monthStart, lt: monthEnd },
      },
    }),
    prisma.auditLog.findMany({
      where: { action: { in: ["subscription.deleted", "subscription.cancel_requested"] }, createdAt: { gte: monthStart, lt: monthEnd } },
      select: { action: true, targetId: true },
    }),
  ]);

  const failedPaymentsThisMonth = await prisma.payment.count({
    where: { status: "FAILED", createdAt: { gte: monthStart, lt: monthEnd } },
  });

  const monthRevenueCents = monthPayments
    .filter((p) => p.status === "SUCCEEDED" || p.status === "PARTIALLY_REFUNDED" || p.status === "REFUNDED")
    .reduce((sum, p) => sum + Math.max(0, p.amount - p.amountRefunded), 0);
  const monthRefundedCents = monthPayments.reduce((sum, p) => sum + p.amountRefunded, 0);
  const totalRevenueCents = allPayments.reduce((sum, p) => sum + Math.max(0, p.amount - p.amountRefunded), 0);
  const totalRefundedCents = allPayments.reduce((sum, p) => sum + p.amountRefunded, 0);

  const billable = subscriptions.filter((s) => s.status === "ACTIVE" || s.status === "TRIALING");
  const mrrCents = billable.reduce(
    (sum, s) => sum + monthlyEquivalentCents(s.planCode as PlanCode, s.interval as BillingIntervalKey),
    0
  );
  const mrrAtRiskCents = subscriptions
    .filter((s) => s.status === "PAST_DUE")
    .reduce((sum, s) => sum + monthlyEquivalentCents(s.planCode as PlanCode, s.interval as BillingIntervalKey), 0);

  const cancellationsThisMonth = new Set(canceledThisMonthAudit.filter((a) => a.action === "subscription.deleted").map((a) => a.targetId)).size;
  const scheduledCancellations = subscriptions.filter((s) => s.cancelAtPeriodEnd && (s.status === "ACTIVE" || s.status === "TRIALING")).length;

  // Historique sur 6 mois (revenus encaissés, nouveaux abonnements, annulations).
  const timeline: MonthPoint[] = [];
  for (let offset = 5; offset >= 0; offset -= 1) {
    const reference = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    const key = monthKey(reference);
    const monthSubs = await prisma.subscription.findMany({
      where: {
        OR: [
          { currentPeriodStart: { gte: reference, lt: new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + 1, 1)) } },
          { canceledAt: { gte: reference, lt: new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + 1, 1)) } },
        ],
      },
      select: { currentPeriodStart: true, canceledAt: true },
    });

    timeline.push({
      key,
      label: reference.toLocaleDateString("fr-FR", { month: "short", year: "2-digit", timeZone: "UTC" }),
      revenueCents: allPayments
        .filter((p) => monthKey(p.createdAt) === key)
        .reduce((sum, p) => sum + Math.max(0, p.amount - p.amountRefunded), 0),
      newSubscriptions: monthSubs.filter((s) => s.currentPeriodStart && monthKey(s.currentPeriodStart) === key).length,
      cancellations: monthSubs.filter((s) => s.canceledAt && monthKey(s.canceledAt) === key).length,
    });
  }

  return {
    currency: subscriptions[0]?.currency ?? "eur",
    monthRevenueCents,
    monthRefundedCents,
    totalRevenueCents,
    totalRefundedCents,
    mrrCents,
    arrCents: mrrCents * 12,
    mrrAtRiskCents,
    arpuCents: billable.length > 0 ? Math.round(mrrCents / billable.length) : 0,
    activeSubscriptions: billable.length,
    trialingSubscriptions: subscriptions.filter((s) => s.status === "TRIALING").length,
    pastDueSubscriptions: subscriptions.filter((s) => s.status === "PAST_DUE").length,
    canceledSubscriptions: subscriptions.filter((s) => s.status === "CANCELED").length,
    newSubscriptionsThisMonth,
    cancellationsThisMonth,
    scheduledCancellations,
    failedPaymentsThisMonth,
    awaitingBankTransfer: monthInvoicesAwaiting.length,
    awaitingBankTransferCents: monthInvoicesAwaiting.reduce((sum, i) => sum + i.amountDue, 0),
    timeline,
  };
}

/** Solde Stripe du propriétaire (disponible, en attente, compte bancaire associé). */
export async function platformBalance(): Promise<AccountStatus | null> {
  try {
    return await getGateway().accountStatus();
  } catch (error) {
    console.error("[metrics] solde de la plateforme indisponible", error);
    return null;
  }
}

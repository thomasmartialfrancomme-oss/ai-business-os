import type { Subscription } from "@prisma/client";
import { env } from "./env";

/**
 * Règle d'accès unique à AI Business OS.
 *
 * ⚠️ Ce fichier est la SEULE autorité en matière d'accès payant.
 * Ni le frontend, ni une page de succès, ni un cookie ne peuvent l'influencer :
 * l'état provient exclusivement de la table `subscriptions`, écrite par le
 * traitement des webhooks Stripe (voir src/lib/payments/state.ts).
 */

const ACCESS_STATUSES: Subscription["status"][] = ["ACTIVE", "TRIALING"];

export interface AccessDecision {
  allowed: boolean;
  reason:
    | "active"
    | "trialing"
    | "cancel_at_period_end"
    | "past_due_grace"
    | "no_subscription"
    | "incomplete"
    | "expired"
    | "canceled"
    | "unpaid"
    | "paused";
  /** Date à laquelle l'accès se termine si aucune régularisation n'a lieu. */
  accessUntil: Date | null;
  graceDaysRemaining: number | null;
}

export function hasAccess(subscription: Subscription | null | undefined): AccessDecision {
  if (!subscription) {
    return { allowed: false, reason: "no_subscription", accessUntil: null, graceDaysRemaining: null };
  }

  const now = new Date();
  const periodEnd = subscription.currentPeriodEnd;

  if (ACCESS_STATUSES.includes(subscription.status)) {
    // Résiliation programmée : l'accès reste ouvert jusqu'à la fin de la période payée.
    if (subscription.cancelAtPeriodEnd) {
      const allowed = !periodEnd || periodEnd > now;
      return {
        allowed,
        reason: allowed ? "cancel_at_period_end" : "canceled",
        accessUntil: periodEnd,
        graceDaysRemaining: null,
      };
    }
    return {
      allowed: true,
      reason: subscription.status === "TRIALING" ? "trialing" : "active",
      accessUntil: periodEnd,
      graceDaysRemaining: null,
    };
  }

  // Échec de paiement : période de grâce configurable (PAST_DUE_GRACE_DAYS) après
  // la fin de la période payée, le temps que Stripe relance la carte.
  // Sans fin de période connue, aucune grâce n'est accordée (défense en profondeur).
  if (subscription.status === "PAST_DUE") {
    if (!periodEnd) {
      return { allowed: false, reason: "past_due_grace", accessUntil: null, graceDaysRemaining: null };
    }
    const graceMs = env.PAST_DUE_GRACE_DAYS * 24 * 3600 * 1000;
    const accessUntil = new Date(periodEnd.getTime() + graceMs);
    const remaining = Math.ceil((accessUntil.getTime() - now.getTime()) / (24 * 3600 * 1000));
    return {
      allowed: accessUntil > now,
      reason: "past_due_grace",
      accessUntil,
      graceDaysRemaining: Math.max(0, remaining),
    };
  }

  const reasonByStatus: Record<string, AccessDecision["reason"]> = {
    INCOMPLETE: "incomplete",
    INCOMPLETE_EXPIRED: "expired",
    CANCELED: "canceled",
    UNPAID: "unpaid",
    PAUSED: "paused",
  };

  return {
    allowed: false,
    reason: reasonByStatus[subscription.status] ?? "no_subscription",
    accessUntil: periodEnd,
    graceDaysRemaining: null,
  };
}

export const ACCESS_REASON_LABELS: Record<AccessDecision["reason"], string> = {
  active: "Abonnement actif",
  trialing: "Période d'essai",
  cancel_at_period_end: "Résiliation programmée — accès maintenu jusqu'à la fin de la période",
  past_due_grace: "Paiement en échec — période de grâce en cours",
  no_subscription: "Aucun abonnement",
  incomplete: "Paiement non finalisé",
  expired: "Abonnement expiré",
  canceled: "Abonnement annulé",
  unpaid: "Impayé",
  paused: "Abonnement en pause",
};

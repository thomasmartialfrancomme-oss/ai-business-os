/**
 * Formatage d'affichage (safe côté client comme côté serveur).
 * Aucune variable d'environnement n'est lue ici.
 */

export function formatMoney(cents: number, currency = "eur", locale = "fr-FR"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatDate(value: Date | string | null | undefined, withTime = false): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Paris",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

export function formatDateShort(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Europe/Paris" });
}

export function daysUntil(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  return Math.ceil((date.getTime() - Date.now()) / (24 * 3600 * 1000));
}

export const SUBSCRIPTION_STATUS_LABELS: Record<string, { label: string; tone: string }> = {
  ACTIVE: { label: "Actif", tone: "badge-success" },
  TRIALING: { label: "Période d'essai", tone: "badge-info" },
  PAST_DUE: { label: "Paiement en retard", tone: "badge-warning" },
  CANCELED: { label: "Annulé", tone: "badge-neutral" },
  UNPAID: { label: "Impayé", tone: "badge-danger" },
  INCOMPLETE: { label: "Paiement non finalisé", tone: "badge-warning" },
  INCOMPLETE_EXPIRED: { label: "Non finalisé (expiré)", tone: "badge-neutral" },
  PAUSED: { label: "En pause", tone: "badge-neutral" },
};

export const INVOICE_STATUS_LABELS: Record<string, { label: string; tone: string }> = {
  DRAFT: { label: "Brouillon", tone: "badge-neutral" },
  OPEN: { label: "En attente de paiement", tone: "badge-warning" },
  PAID: { label: "Payée", tone: "badge-success" },
  AWAITING_BANK_TRANSFER: { label: "En attente de virement", tone: "badge-warning" },
  VOID: { label: "Annulée", tone: "badge-neutral" },
  UNCOLLECTIBLE: { label: "Irrécouvrable", tone: "badge-danger" },
  REFUNDED: { label: "Remboursée", tone: "badge-info" },
  PARTIALLY_REFUNDED: { label: "Partiellement remboursée", tone: "badge-info" },
};

export const PAYMENT_STATUS_LABELS: Record<string, { label: string; tone: string }> = {
  PENDING: { label: "En attente", tone: "badge-neutral" },
  SUCCEEDED: { label: "Réussi", tone: "badge-success" },
  FAILED: { label: "Échoué", tone: "badge-danger" },
  REFUNDED: { label: "Remboursé", tone: "badge-info" },
  PARTIALLY_REFUNDED: { label: "Part. remboursé", tone: "badge-info" },
};

export const INTERVAL_LABELS: Record<string, string> = {
  MONTH: "mensuel",
  YEAR: "annuel",
};

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CARD: "Carte bancaire (Stripe)",
  BANK_TRANSFER: "Virement bancaire",
};

export function statusInfo(
  map: Record<string, { label: string; tone: string }>,
  status: string | null | undefined
): { label: string; tone: string } {
  if (!status) return { label: "—", tone: "badge-neutral" };
  return map[status] ?? { label: status, tone: "badge-neutral" };
}

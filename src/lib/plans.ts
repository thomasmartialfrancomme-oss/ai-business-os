/**
 * Catalogue des offres AI Business OS.
 *
 * Les montants sont stockés en centimes (entiers) — jamais de flottants pour l'argent.
 * Les identifiants de prix Stripe sont injectés par variables d'environnement
 * (voir scripts/stripe-setup.ts qui les crée dans VOTRE compte Stripe).
 */

export const PLAN_CODES = ["STARTER", "PRO", "BUSINESS"] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export const BILLING_INTERVALS = ["MONTH", "YEAR"] as const;
export type BillingIntervalKey = (typeof BILLING_INTERVALS)[number];

export interface PlanDefinition {
  code: PlanCode;
  name: string;
  tagline: string;
  /** Prix mensuel en centimes, hors réduction. */
  monthlyCents: number;
  currency: string;
  featured?: boolean;
  features: string[];
  limits: { seats: number; aiCreditsPerMonth: number; automations: number };
}

export const PLANS: Record<PlanCode, PlanDefinition> = {
  STARTER: {
    code: "STARTER",
    name: "Starter",
    tagline: "Pour démarrer et tester AI Business OS sur un vrai business.",
    monthlyCents: 2900,
    currency: "eur",
    features: [
      "1 utilisateur",
      "Assistant IA & génération de contenu",
      "500 crédits IA / mois",
      "5 automatisations actives",
      "Support par e-mail",
    ],
    limits: { seats: 1, aiCreditsPerMonth: 500, automations: 5 },
  },
  PRO: {
    code: "PRO",
    name: "Pro",
    tagline: "Le forfait le plus choisi : IA + automatisations illimitées.",
    monthlyCents: 5900,
    currency: "eur",
    featured: true,
    features: [
      "5 utilisateurs",
      "Automatisations illimitées",
      "5 000 crédits IA / mois",
      "Pipeline commercial & CRM",
      "Intégrations (Stripe, e-mail, calendrier)",
      "Support prioritaire",
    ],
    limits: { seats: 5, aiCreditsPerMonth: 5000, automations: 10_000 },
  },
  BUSINESS: {
    code: "BUSINESS",
    name: "Business",
    tagline: "Pour les équipes : gouvernance, API et accompagnement.",
    monthlyCents: 9900,
    currency: "eur",
    features: [
      "Utilisateurs illimités",
      "Crédits IA illimités (fair use)",
      "Accès API & webhooks",
      "SSO / rôles avancés",
      "Journal d'audit & export comptable",
      "Support dédié + onboarding",
    ],
    limits: { seats: 100, aiCreditsPerMonth: 1_000_000, automations: 1_000_000 },
  },
};

export const DEFAULT_ANNUAL_DISCOUNT_PERCENT = 20;

/** Réduction annuelle configurable (ANNUAL_DISCOUNT_PERCENT). */
export function annualDiscountPercent(): number {
  const raw = Number(process.env.ANNUAL_DISCOUNT_PERCENT ?? DEFAULT_ANNUAL_DISCOUNT_PERCENT);
  if (!Number.isFinite(raw)) return DEFAULT_ANNUAL_DISCOUNT_PERCENT;
  return Math.min(90, Math.max(0, raw));
}

/**
 * Prix annuel = 12 mois moins la réduction configurable, arrondi à l'euro
 * inférieur pour rester lisible sur la page tarifs.
 */
export function annualCents(code: PlanCode, discountPercent = annualDiscountPercent()): number {
  const plan = PLANS[code];
  const gross = plan.monthlyCents * 12;
  const discounted = gross * (1 - discountPercent / 100);
  return Math.floor(discounted / 100) * 100;
}

/** Prix d'une offre pour un intervalle donné, en centimes. */
export function priceCents(
  code: PlanCode,
  interval: BillingIntervalKey,
  discountPercent = annualDiscountPercent()
): number {
  return interval === "YEAR" ? annualCents(code, discountPercent) : PLANS[code].monthlyCents;
}

/** Prix ramené au mois (utilisé pour le calcul du MRR d'un abonnement annuel). */
export function monthlyEquivalentCents(
  code: PlanCode,
  interval: BillingIntervalKey,
  discountPercent = annualDiscountPercent()
): number {
  return interval === "YEAR" ? Math.round(annualCents(code, discountPercent) / 12) : PLANS[code].monthlyCents;
}

export function isPlanCode(value: unknown): value is PlanCode {
  return typeof value === "string" && (PLAN_CODES as readonly string[]).includes(value);
}

export function isBillingInterval(value: unknown): value is BillingIntervalKey {
  return typeof value === "string" && (BILLING_INTERVALS as readonly string[]).includes(value);
}

/**
 * Variable d'environnement contenant l'ID de prix Stripe (price_…) d'une offre.
 * Ex : STRIPE_PRICE_ID_PRO_MONTH
 */
export function stripePriceEnvKey(code: PlanCode, interval: BillingIntervalKey): string {
  return `STRIPE_PRICE_ID_${code}_${interval}`;
}

/** ID de prix Stripe configuré pour cette offre (ou null si non configuré). */
export function stripePriceIdFor(code: PlanCode, interval: BillingIntervalKey): string | null {
  const value = process.env[stripePriceEnvKey(code, interval)];
  return value && value.startsWith("price_") ? value : null;
}

/** Retrouve l'offre à partir d'un ID de prix Stripe (utilisé par les webhooks). */
export function planFromStripePriceId(priceId: string | null | undefined): PlanCode | null {
  if (!priceId) return null;
  for (const code of PLAN_CODES) {
    for (const interval of BILLING_INTERVALS) {
      if (process.env[stripePriceEnvKey(code, interval)] === priceId) return code;
    }
  }
  return null;
}

export function intervalFromStripePriceId(priceId: string | null | undefined): BillingIntervalKey | null {
  if (!priceId) return null;
  for (const code of PLAN_CODES) {
    for (const interval of BILLING_INTERVALS) {
      if (process.env[stripePriceEnvKey(code, interval)] === priceId) return interval;
    }
  }
  return null;
}

export function formatMoney(cents: number, currency = "eur", locale = "fr-FR"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function planLabel(code: string, interval?: string): string {
  const plan = (PLANS as Record<string, PlanDefinition>)[code];
  const base = plan ? plan.name : code;
  if (!interval) return base;
  return `${base} — ${interval === "YEAR" ? "annuel" : "mensuel"}`;
}

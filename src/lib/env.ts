import { z } from "zod";

/**
 * Configuration serveur. TOUTES les clés sensibles restent ici (côté serveur),
 * lues depuis les variables d'environnement. Aucune clé secrète n'est jamais
 * envoyée au navigateur (voir src/lib/env.public.ts pour les valeurs exposables).
 */

const schema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL est requise"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  APP_SECRET: z.string().min(16, "APP_SECRET doit faire au moins 16 caractères"),

  // Stripe — optionnel : si absent, le module bascule en mode simulation.
  STRIPE_SECRET_KEY: z.string().optional().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().optional().default(""),
  STRIPE_PUBLISHABLE_KEY: z.string().optional().default(""),

  // Sécurité : n'autorise les routes de simulation que si explicitement activé.
  ALLOW_SIMULATION: z.string().optional().default("auto"),

  // Sécurité : la connexion de démonstration (choix d'un utilisateur par e-mail,
  // sans mot de passe) est DÉSACTIVÉE par défaut en production. Mettez-la à "true"
  // uniquement pour une démonstration privée, jamais sur un site public.
  DEMO_LOGIN: z.string().optional().default("auto"),

  // Catalogue : réduction annuelle configurable (en pourcentage).
  ANNUAL_DISCOUNT_PERCENT: z.coerce.number().min(0).max(90).default(20),

  // Période de grâce après un échec de paiement avant coupure d'accès (jours).
  PAST_DUE_GRACE_DAYS: z.coerce.number().min(0).max(60).default(3),

  // Coordonnées bancaires de réception (virement) — configurées par le propriétaire.
  BANK_ACCOUNT_HOLDER: z.string().optional().default(""),
  BANK_NAME: z.string().optional().default(""),
  BANK_IBAN: z.string().optional().default(""),
  BANK_BIC: z.string().optional().default(""),
  BANK_ADDRESS: z.string().optional().default(""),
  BANK_ROUTING_NOTE: z.string().optional().default(""),

  OWNER_EMAIL: z.string().email().default("owner@ai-business-os.test"),
});

export type StripeMode = "live" | "test" | "simulation";

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues.map((i) => ` - ${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Configuration d'environnement invalide :\n${details}`);
}

const raw = parsed.data;

/**
 * Détermine le mode de paiement à partir de la clé Stripe fournie.
 * - sk_live_…  -> "live"       : argent réel, compte Stripe du propriétaire
 * - sk_test_…  -> "test"       : environnement Stripe TEST
 * - (aucune)   -> "simulation" : aucun compte Stripe requis (démo / tests)
 */
function detectStripeMode(key: string): StripeMode {
  if (!key) return "simulation";
  if (key.startsWith("sk_live_")) return "live";
  if (key.startsWith("sk_test_")) return "test";
  return "simulation";
}

const stripeMode = detectStripeMode(raw.STRIPE_SECRET_KEY);

const simulationAllowed =
  raw.ALLOW_SIMULATION === "auto" ? stripeMode === "simulation" : raw.ALLOW_SIMULATION === "true";

if (!raw.STRIPE_SECRET_KEY && raw.ALLOW_SIMULATION === "false") {
  throw new Error(
    "Aucune clé Stripe fournie (STRIPE_SECRET_KEY) et ALLOW_SIMULATION=false : le module ne peut pas fonctionner."
  );
}

if (stripeMode === "live" && process.env.NODE_ENV !== "production") {
  // Garde-fou : on refuse une clé live hors production pour éviter tout débit réel en dev.
  throw new Error(
    "Clé Stripe LIVE détectée hors production. Utilisez une clé sk_test_… en développement."
  );
}

const demoLoginEnabled =
  raw.DEMO_LOGIN === "true" ? true : raw.DEMO_LOGIN === "false" ? false : process.env.NODE_ENV !== "production";

if (demoLoginEnabled && process.env.NODE_ENV === "production" && raw.DEMO_LOGIN !== "true") {
  // Ne devrait jamais arriver : la démonstration est coupée par défaut en production.
  console.warn("[env] DEMO_LOGIN ≠ false en production : la connexion de démonstration est active.");
}

export const env = {
  ...raw,
  stripeMode,
  simulationAllowed,
  demoLoginEnabled,
  /** Paiements réellement traités par Stripe (test ou live). */
  isStripeBacked: stripeMode !== "simulation",
  /** Secret utilisé pour vérifier les signatures de webhook (généré localement en simulation). */
  stripeWebhookSecret: raw.STRIPE_WEBHOOK_SECRET,
  isProduction: process.env.NODE_ENV === "production",
} as const;

export function assertServerOnly(context: string): void {
  if (typeof window !== "undefined") {
    throw new Error(`${context} ne peut être appelé que côté serveur.`);
  }
}

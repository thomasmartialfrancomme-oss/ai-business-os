/**
 * Socle commun des tests.
 *
 * IMPORTANT : ce module doit être le PREMIER importé par un fichier de test.
 * Il positionne les variables d'environnement (base de test, mode simulation)
 * AVANT que src/lib/env.ts ne soit évalué. Les modules de l'application sont donc
 * chargés dynamiquement à l'intérieur des tests.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? "postgresql://postgres@127.0.0.1:5432/aibos_test?schema=public";
process.env.APP_SECRET = "test-secret-aibos-module-paiement-000000";
process.env.APP_URL = process.env.APP_URL ?? "http://localhost:3000";
process.env.STRIPE_SECRET_KEY = "";
process.env.STRIPE_WEBHOOK_SECRET = "";
process.env.ALLOW_SIMULATION = "true";
process.env.ANNUAL_DISCOUNT_PERCENT = "20";
process.env.PAST_DUE_GRACE_DAYS = "3";
// (NODE_ENV est fourni par le lanceur de tests ; on n'y touche pas ici.)

export type AppModules = {
  prisma: typeof import("../src/lib/db").prisma;
  gateway: import("../src/lib/payments/types").PaymentGateway;
  webhook: typeof import("../src/lib/payments/webhook");
  state: typeof import("../src/lib/payments/state");
  service: typeof import("../src/lib/payments/service");
  plans: typeof import("../src/lib/plans");
  fixtures: typeof import("../src/lib/payments/fixtures");
  signature: typeof import("../src/lib/payments/signature");
  access: typeof import("../src/lib/access");
  bankTransfer: typeof import("../src/lib/payments/bank-transfer");
  events: typeof import("../src/lib/payments/events");
};

let cached: AppModules | null = null;

/** Charge l'application une seule fois (les variables d'environnement sont en place). */
export async function app(): Promise<AppModules> {
  if (cached) return cached;
  const [
    { prisma },
    { getGateway },
    webhook,
    state,
    service,
    plans,
    fixtures,
    signature,
    access,
    bankTransfer,
    events,
  ] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/payments"),
    import("../src/lib/payments/webhook"),
    import("../src/lib/payments/state"),
    import("../src/lib/payments/service"),
    import("../src/lib/plans"),
    import("../src/lib/payments/fixtures"),
    import("../src/lib/payments/signature"),
    import("../src/lib/access"),
    import("../src/lib/payments/bank-transfer"),
    import("../src/lib/payments/events"),
  ]);

  cached = {
    prisma,
    gateway: getGateway(),
    webhook,
    state,
    service,
    plans,
    fixtures,
    signature,
    access,
    bankTransfer,
    events,
  };
  return cached;
}

/** Remet la base de test dans un état vierge (ordre compatible avec les clés étrangères). */
export async function resetDatabase(): Promise<void> {
  const { prisma } = await app();
  await prisma.auditLog.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.user.deleteMany();
  await prisma.simObject.deleteMany();
  await prisma.platformSetting.deleteMany();
}

export async function createUser(email: string, name = "Client Test", role: "CUSTOMER" | "OWNER" = "CUSTOMER") {
  const { prisma } = await app();
  const user = await prisma.user.create({ data: { email, name, role } });
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isOwner: user.role === "OWNER",
  };
}

/** Ouvre une session de checkout (sans payer) — le client en est à l'étape « saisie de carte ». */
export async function startCheckout(input: {
  user: { id: string; email: string; name: string; role: "CUSTOMER" | "OWNER"; isOwner: boolean };
  planCode: "STARTER" | "PRO" | "BUSINESS";
  interval?: "MONTH" | "YEAR";
}) {
  const { service } = await app();
  return service.createSubscriptionCheckout({
    user: input.user,
    planCode: input.planCode,
    interval: input.interval ?? "MONTH",
    origin: "http://localhost:3000",
  });
}

/** Joue le paiement d'une session (comme le testeur de cartes Stripe). */
export async function payCheckout(
  sessionId: string,
  outcome: "success" | "declined" | "insufficient_funds" | "requires_action" = "success"
) {
  const { gateway, events } = await app();
  const simulation = await gateway.simulate!({ type: "pay_checkout", sessionId, outcome });
  const deliveries = await events.deliverEvents(simulation.events);
  return { simulation, deliveries, outcome };
}

/** Souscrit via le service applicatif puis joue le paiement dans la passerelle simulée. */
export async function subscribe(input: {
  user: { id: string; email: string; name: string; role: "CUSTOMER" | "OWNER"; isOwner: boolean };
  planCode: "STARTER" | "PRO" | "BUSINESS";
  interval?: "MONTH" | "YEAR";
  outcome?: "success" | "declined" | "insufficient_funds" | "requires_action";
}) {
  const { service, gateway, events } = await app();
  const checkout = await service.createSubscriptionCheckout({
    user: input.user,
    planCode: input.planCode,
    interval: input.interval ?? "MONTH",
    origin: "http://localhost:3000",
  });

  const outcome = input.outcome ?? "success";
  const simulation = await gateway.simulate!({ type: "pay_checkout", sessionId: checkout.sessionId, outcome });
  const deliveries = await events.deliverEvents(simulation.events);

  return { checkout, simulation, deliveries, outcome };
}

/** Renouvellement (ou échec de renouvellement) simulé pour un abonnement existant. */
export async function renew(subscriptionId: string, outcome: "success" | "failed") {
  const { gateway, events } = await app();
  const simulation = await gateway.simulate!({ type: "renew_subscription", subscriptionId, outcome });
  const deliveries = await events.deliverEvents(simulation.events);
  return { simulation, deliveries };
}

/** Signe et livre un événement au pipeline de webhook (comme le ferait Stripe). */
export async function deliverEvent(
  event: unknown,
  options: { secret?: string; signature?: string } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { webhook } = await app();
  const raw = JSON.stringify(event);
  // Secret courant du pipeline (variable d'environnement ou secret de simulation en base).
  const secret = options.secret ?? (await currentWebhookSecret());
  const signature = options.signature ?? sign(raw, secret);
  const result = await webhook.processWebhook(raw, signature);
  return { status: result.status, body: result.body };
}

function sign(payload: string, secret: string): string {
  // Reproduit l'en-tête Stripe-Signature : t=<ts>,v1=<hmac>
  const timestamp = Math.floor(Date.now() / 1000);
  const { createHmac } = require("node:crypto") as typeof import("node:crypto");
  const hmac = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${hmac}`;
}

/** Signature invalide (mauvais secret). */
export function badSignature(payload: string): string {
  return sign(payload, "whsec_secret_completement_different");
}

/** Signature correcte mais ancienne (au-delà de la tolérance de 5 minutes). */
export function staleSignature(payload: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000) - 60 * 60 * 24;
  const { createHmac } = require("node:crypto") as typeof import("node:crypto");
  const hmac = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${hmac}`;
}

/** Secret de signature courant (le crée si nécessaire, comme le ferait le serveur au premier webhook). */
export async function currentWebhookSecret(): Promise<string> {
  const { getWebhookSecret } = await import("../src/lib/payments");
  return (await getWebhookSecret()) ?? "";
}

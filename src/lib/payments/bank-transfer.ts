import { randomBytes } from "node:crypto";
import { prisma } from "../db";
import { env } from "../env";
import { writeAudit } from "../audit";
import { PLANS, isBillingInterval, isPlanCode, priceCents, type BillingIntervalKey, type PlanCode } from "../plans";
import type { SessionUser } from "../auth";
import { BillingError } from "./service";

/**
 * ══════════════════════════════════════════════════════════════════════════════
 *  PAIEMENT PAR VIREMENT BANCAIRE (clients professionnels)
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Principes non négociables :
 *  1. aucun accès n'est accordé à la création de la facture virement ;
 *  2. la confirmation est TOUJOURS un acte explicite (administrateur ou rapprochement
 *     bancaire), jamais déduite de la bonne foi du client ;
 *  3. le passage à PAID est tracé (qui, quand, sur quelle référence) ;
 *  4. les coordonnées bancaires affichées sont celles configurées par le propriétaire
 *     de la plateforme — jamais des coordonnées codées en dur dans le code.
 */

const BANK_SETTINGS_KEY = "bank_transfer";
const DECLARATION_DEADLINE_DAYS = 7;

export interface BankDetails {
  accountHolder: string;
  bankName: string;
  iban: string;
  bic: string;
  bankAddress: string;
  note: string;
}

/** Coordonnées bancaires de réception : base de données (admin) puis variables d'environnement. */
export async function getBankDetails(): Promise<BankDetails & { configured: boolean }> {
  const row = await prisma.platformSetting.findUnique({ where: { key: BANK_SETTINGS_KEY } });
  const stored = (row?.value ?? {}) as Partial<BankDetails>;

  const details: BankDetails = {
    accountHolder: stored.accountHolder || env.BANK_ACCOUNT_HOLDER,
    bankName: stored.bankName || env.BANK_NAME,
    iban: stored.iban || env.BANK_IBAN,
    bic: stored.bic || env.BANK_BIC,
    bankAddress: stored.bankAddress || env.BANK_ADDRESS,
    note: stored.note || env.BANK_ROUTING_NOTE,
  };

  return { ...details, configured: Boolean(details.iban && details.accountHolder) };
}

export async function saveBankDetails(owner: SessionUser, details: Partial<BankDetails>): Promise<void> {
  const current = await getBankDetails();
  const next: BankDetails = {
    accountHolder: details.accountHolder ?? current.accountHolder,
    bankName: details.bankName ?? current.bankName,
    iban: details.iban ?? current.iban,
    bic: details.bic ?? current.bic,
    bankAddress: details.bankAddress ?? current.bankAddress,
    note: details.note ?? current.note,
  };

  await prisma.platformSetting.upsert({
    where: { key: BANK_SETTINGS_KEY },
    create: { key: BANK_SETTINGS_KEY, value: next as unknown as object },
    update: { value: next as unknown as object },
  });

  await writeAudit({
    actorType: "ADMIN",
    actorId: owner.id,
    action: "bank_details.updated",
    targetType: "platform_setting",
    targetId: BANK_SETTINGS_KEY,
    // On ne recopie JAMAIS l'IBAN complet dans le journal d'audit.
    metadata: { accountHolder: next.accountHolder, bankName: next.bankName, ibanLast4: next.iban.slice(-4) },
  });
}

function generateReference(): string {
  const year = new Date().getFullYear();
  const random = randomBytes(4).toString("hex").toUpperCase();
  return `AIB-${year}-${random}`;
}

export interface BankTransferInvoiceResult {
  invoiceId: string;
  reference: string;
  amountCents: number;
  currency: string;
  dueDate: Date;
  bankDetails: BankDetails;
  planCode: PlanCode;
  interval: BillingIntervalKey;
}

/**
 * Crée une facture en attente de virement (statut AWAITING_BANK_TRANSFER).
 * Aucun droit d'accès n'est accordé à ce stade.
 */
export async function createBankTransferInvoice(input: {
  user: SessionUser;
  planCode: string;
  interval: string;
}): Promise<BankTransferInvoiceResult> {
  if (!isPlanCode(input.planCode)) throw new BillingError("Forfait inconnu.", "unknown_plan");
  if (!isBillingInterval(input.interval)) throw new BillingError("Périodicité inconnue.", "unknown_interval");

  const planCode = input.planCode;
  const interval = input.interval;
  const plan = PLANS[planCode];
  const amountCents = priceCents(planCode, interval);
  const bankDetails = await getBankDetails();

  if (!bankDetails.configured) {
    throw new BillingError(
      "Le virement bancaire n'est pas disponible : les coordonnées bancaires n'ont pas encore été configurées par l'administrateur.",
      "bank_details_not_configured",
      503
    );
  }

  const existing = await prisma.subscription.findUnique({ where: { userId: input.user.id } });
  if (existing && ["ACTIVE", "TRIALING"].includes(existing.status) && existing.lastStripeEventAt) {
    throw new BillingError("Un abonnement est déjà actif sur ce compte.", "already_subscribed", 409);
  }

  const pending = await prisma.invoice.findFirst({
    where: { userId: input.user.id, status: "AWAITING_BANK_TRANSFER" },
    orderBy: { createdAt: "desc" },
  });
  if (pending) {
    return {
      invoiceId: pending.id,
      reference: pending.bankTransferReference ?? "",
      amountCents: pending.amountDue,
      currency: pending.currency,
      dueDate: new Date(pending.createdAt.getTime() + DECLARATION_DEADLINE_DAYS * 24 * 3600 * 1000),
      bankDetails,
      planCode: (pending.planCode as PlanCode) ?? planCode,
      interval: (pending.interval as BillingIntervalKey) ?? interval,
    };
  }

  const reference = generateReference();
  const periodStart = new Date();
  const periodEnd = new Date(periodStart.getTime() + (interval === "YEAR" ? 365 : 30) * 24 * 3600 * 1000);

  const invoice = await prisma.invoice.create({
    data: {
      userId: input.user.id,
      subscriptionId: existing?.id ?? null,
      number: reference,
      status: "AWAITING_BANK_TRANSFER",
      paymentMethod: "BANK_TRANSFER",
      planCode,
      interval: interval === "YEAR" ? "YEAR" : "MONTH",
      amountDue: amountCents,
      amountPaid: 0,
      currency: plan.currency,
      periodStart,
      periodEnd,
      bankTransferReference: reference,
      // Instantané des coordonnées au moment de l'émission : un changement ultérieur
      // côté admin n'altère pas la facture déjà émise.
      bankTransferInstructions: {
        accountHolder: bankDetails.accountHolder,
        bankName: bankDetails.bankName,
        iban: bankDetails.iban,
        bic: bankDetails.bic,
        bankAddress: bankDetails.bankAddress,
        note: bankDetails.note,
        reference,
        amount: `${(amountCents / 100).toFixed(2)} ${plan.currency.toUpperCase()}`,
        plan: `${plan.name} — ${interval === "YEAR" ? "annuel" : "mensuel"}`,
        deadline: new Date(periodStart.getTime() + DECLARATION_DEADLINE_DAYS * 24 * 3600 * 1000).toISOString(),
        warning: "Indiquez impérativement la référence dans le libellé du virement.",
      },
    },
  });

  await writeAudit({
    actorType: "CUSTOMER",
    actorId: input.user.id,
    action: "bank_transfer.invoice_created",
    targetType: "invoice",
    targetId: invoice.id,
    userId: input.user.id,
    metadata: { reference, amountCents, planCode, interval },
  });

  return {
    invoiceId: invoice.id,
    reference,
    amountCents,
    currency: plan.currency,
    dueDate: new Date(periodStart.getTime() + DECLARATION_DEADLINE_DAYS * 24 * 3600 * 1000),
    bankDetails,
    planCode,
    interval,
  };
}

/** Le client déclare avoir effectué le virement : information, PAS un paiement. */
export async function declareBankTransfer(input: {
  user: SessionUser;
  invoiceId: string;
  reference: string;
  note?: string;
}): Promise<{ declaredAt: Date }> {
  const invoice = await prisma.invoice.findUnique({ where: { id: input.invoiceId } });
  if (!invoice || invoice.userId !== input.user.id) throw new BillingError("Facture introuvable.", "not_found", 404);
  if (invoice.status !== "AWAITING_BANK_TRANSFER") {
    throw new BillingError("Cette facture n'est plus en attente de virement.", "invalid_status", 409);
  }
  if (invoice.bankTransferReference !== input.reference.trim().toUpperCase()) {
    throw new BillingError("Référence de virement incorrecte.", "invalid_reference", 400);
  }

  const declaredAt = new Date();
  await prisma.invoice.update({
    where: { id: invoice.id },
    data: { bankTransferDeclaredAt: declaredAt, bankTransferNote: input.note ?? null },
  });

  await writeAudit({
    actorType: "CUSTOMER",
    actorId: input.user.id,
    action: "bank_transfer.declared_by_customer",
    targetType: "invoice",
    targetId: invoice.id,
    userId: input.user.id,
    metadata: { reference: invoice.bankTransferReference, note: input.note ?? null },
  });

  // ⚠️ Aucun changement de statut : la facture reste AWAITING_BANK_TRANSFER
  // jusqu'à confirmation du rapprochement bancaire par un administrateur.
  return { declaredAt };
}

/**
 * Confirmation administrative sécurisée : passage à PAID.
 * Réservée au propriétaire de la plateforme. Trois garde-fous :
 *   - vérification du rôle OWNER par l'appelant (requireOwner) ;
 *   - correspondance de la référence ;
 *   - traçabilité complète (qui a confirmé, quand).
 *
 * Optionnellement, l'écriture comptable peut être répliquée dans Stripe
 * (facture réglée hors ligne) pour garder un rapprochement unique.
 */
export async function confirmBankTransfer(input: {
  owner: SessionUser;
  invoiceId: string;
  reference: string;
  note?: string;
  recordInStripe?: boolean;
}): Promise<{ invoiceId: string; status: "PAID"; subscriptionStatus: string; providerInvoiceId: string | null }> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: input.invoiceId },
    include: { user: true, subscription: true },
  });
  if (!invoice) throw new BillingError("Facture introuvable.", "not_found", 404);
  if (invoice.status === "PAID") throw new BillingError("Cette facture est déjà marquée payée.", "already_paid", 409);
  if (invoice.status !== "AWAITING_BANK_TRANSFER") {
    throw new BillingError("Seule une facture en attente de virement peut être confirmée.", "invalid_status", 409);
  }
  if (invoice.bankTransferReference !== input.reference.trim().toUpperCase()) {
    throw new BillingError("Référence de virement incorrecte : confirmation refusée.", "invalid_reference", 400);
  }

  const confirmedAt = new Date();
  const planCode = (invoice.planCode as PlanCode) ?? "STARTER";
  const interval = (invoice.interval as BillingIntervalKey) ?? "MONTH";

  // Réplication comptable dans Stripe (facultative, best-effort, jamais bloquante).
  let providerInvoiceId: string | null = null;
  if (input.recordInStripe) {
    const { getGateway } = await import(".");
    const gateway = getGateway();
    if (gateway.recordBankTransferPayment && invoice.subscription?.stripeCustomerId) {
      try {
        const recorded = await gateway.recordBankTransferPayment({
          customerId: invoice.subscription.stripeCustomerId,
          amountCents: invoice.amountDue,
          currency: invoice.currency,
          description: `Abonnement AI Business OS ${planCode} (${interval === "YEAR" ? "annuel" : "mensuel"}) — virement bancaire`,
          reference: invoice.bankTransferReference ?? invoice.id,
        });
        providerInvoiceId = recorded.providerInvoiceId;
      } catch (error) {
        await writeAudit({
          actorType: "SYSTEM",
          action: "bank_transfer.stripe_recording_failed",
          targetType: "invoice",
          targetId: invoice.id,
          userId: invoice.userId,
          metadata: { error: error instanceof Error ? error.message : String(error) },
        });
      }
    }
  }

  await prisma.invoice.update({
    where: { id: invoice.id },
    data: {
      status: "PAID",
      amountPaid: invoice.amountDue,
      paidAt: confirmedAt,
      bankTransferConfirmedBy: input.owner.email,
      bankTransferConfirmedAt: confirmedAt,
      bankTransferNote: input.note ?? invoice.bankTransferNote,
    },
  });

  // Une trace de paiement est créée : l'argent est bien encaissé (hors carte).
  await prisma.payment.create({
    data: {
      userId: invoice.userId,
      invoiceId: invoice.id,
      amount: invoice.amountDue,
      currency: invoice.currency,
      status: "SUCCEEDED",
      method: "BANK_TRANSFER",
    },
  });

  // Activation de l'abonnement pour la période payée : c'est la confirmation FIABLE
  // exigée avant de donner accès au service.
  const periodStart = invoice.periodStart ?? confirmedAt;
  const periodEnd =
    invoice.periodEnd ?? new Date(periodStart.getTime() + (interval === "YEAR" ? 365 : 30) * 24 * 3600 * 1000);

  const subscription = await prisma.subscription.upsert({
    where: { userId: invoice.userId },
    create: {
      userId: invoice.userId,
      planCode,
      interval: interval === "YEAR" ? "YEAR" : "MONTH",
      status: "ACTIVE",
      amountCents: invoice.amountDue,
      currency: invoice.currency,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      lastPaymentStatus: "paid",
      lastPaymentAt: confirmedAt,
      lastStripeEventId: `bank_transfer_${invoice.id}`,
      lastStripeEventAt: confirmedAt,
    },
    update: {
      planCode,
      interval: interval === "YEAR" ? "YEAR" : "MONTH",
      status: "ACTIVE",
      amountCents: invoice.amountDue,
      currency: invoice.currency,
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      lastPaymentStatus: "paid",
      lastPaymentAt: confirmedAt,
      lastFailureCode: null,
      lastFailureMessage: null,
      lastStripeEventId: `bank_transfer_${invoice.id}`,
      lastStripeEventAt: confirmedAt,
    },
  });

  await writeAudit({
    actorType: "ADMIN",
    actorId: input.owner.id,
    action: "bank_transfer.confirmed",
    targetType: "invoice",
    targetId: invoice.id,
    userId: invoice.userId,
    metadata: {
      confirmedBy: input.owner.email,
      reference: invoice.bankTransferReference,
      amountCents: invoice.amountDue,
      providerInvoiceId,
      note: input.note ?? null,
    },
  });

  return { invoiceId: invoice.id, status: "PAID", subscriptionStatus: subscription.status, providerInvoiceId };
}

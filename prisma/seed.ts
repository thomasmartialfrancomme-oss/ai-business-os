import { PrismaClient } from "@prisma/client";
import { PLANS, priceCents, type BillingIntervalKey, type PlanCode } from "../src/lib/plans";

/**
 * Jeu de données de démonstration.
 *
 * Objectif : que /billing, /admin/revenue et /sim montrent immédiatement des
 * situations réalistes (actif, en retard, annulé, virement en attente, historique
 * de paiements sur 6 mois).
 *
 * ⚠️ Ces écritures sont réservées au peuplement initial : en exploitation, l'état
 * des abonnements et des paiements est écrit EXCLUSIVEMENT par le pipeline de
 * webhooks (src/lib/payments/state.ts).
 */

const prisma = new PrismaClient();

const day = 24 * 3600 * 1000;
const now = new Date();
const ago = (days: number) => new Date(now.getTime() - days * day);
const ahead = (days: number) => new Date(now.getTime() + days * day);
const monthStart = (offset: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1, 12));

const MONTH: { interval: "MONTH"; code: PlanCode; amount: (code: PlanCode) => number } = {
  interval: "MONTH",
  code: "PRO",
  amount: (code) => priceCents(code, "MONTH"),
};

void MONTH;

async function main() {
  console.log("→ Nettoyage des données existantes…");
  // L'ordre respecte les contraintes de clés étrangères.
  await prisma.auditLog.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.user.deleteMany();
  await prisma.simObject.deleteMany();

  console.log("→ Création des utilisateurs…");
  const owner = await prisma.user.create({
    data: { email: process.env.OWNER_EMAIL ?? "owner@ai-business-os.test", name: "Aurélie — Propriétaire", role: "OWNER" },
  });

  const alice = await prisma.user.create({ data: { email: "alice@exemple.fr", name: "Alice Rivière" } });
  const bruno = await prisma.user.create({ data: { email: "bruno@exemple.fr", name: "Bruno Delcourt" } });
  const chloe = await prisma.user.create({ data: { email: "chloe@exemple.fr", name: "Chloé Ménard" } });
  const david = await prisma.user.create({ data: { email: "david@exemple.fr", name: "David Osei" } });
  const emma = await prisma.user.create({ data: { email: "emma@exemple.fr", name: "Emma Tanaka" } });
  const farid = await prisma.user.create({ data: { email: "farid@exemple.fr", name: "Farid Benali (Cabinet FB)" } });

  console.log("→ Abonnements de démonstration…");

  // 1) Alice — PRO mensuel actif depuis 3 mois (historique de paiements)
  const aliceSub = await prisma.subscription.create({
    data: {
      userId: alice.id,
      stripeCustomerId: "cus_demo_alice",
      stripeSubscriptionId: "sub_demo_alice",
      stripePriceId: process.env.STRIPE_PRICE_ID_PRO_MONTH || "price_sim_PRO_MONTH",
      planCode: "PRO",
      interval: "MONTH",
      status: "ACTIVE",
      amountCents: priceCents("PRO", "MONTH"),
      currency: "eur",
      currentPeriodStart: ago(8),
      currentPeriodEnd: ahead(22),
      lastPaymentStatus: "paid",
      lastPaymentAt: ago(8),
      lastStripeEventId: "evt_demo_alice",
      lastStripeEventAt: ago(8),
    },
  });

  for (let offset = 3; offset >= 0; offset -= 1) {
    const periodStart = offset === 0 ? ago(8) : monthStart(offset);
    const periodEnd = new Date(periodStart.getTime() + 30 * day);
    const invoice = await prisma.invoice.create({
      data: {
        userId: alice.id,
        subscriptionId: aliceSub.id,
        stripeInvoiceId: `in_demo_alice_${offset}`,
        number: `AIBOS-${now.getFullYear()}-10${offset}`,
        status: "PAID",
        paymentMethod: "CARD",
        planCode: "PRO",
        interval: "MONTH",
        amountDue: priceCents("PRO", "MONTH"),
        amountPaid: priceCents("PRO", "MONTH"),
        currency: "eur",
        periodStart,
        periodEnd,
        paidAt: periodStart,
        hostedInvoiceUrl: `https://invoice.stripe.com/i/in_demo_alice_${offset}`,
        invoicePdfUrl: `https://pay.stripe.com/invoice/in_demo_alice_${offset}/pdf`,
        createdAt: periodStart,
      },
    });
    await prisma.payment.create({
      data: {
        userId: alice.id,
        invoiceId: invoice.id,
        stripePaymentIntentId: `pi_demo_alice_${offset}`,
        stripeChargeId: `ch_demo_alice_${offset}`,
        amount: priceCents("PRO", "MONTH"),
        currency: "eur",
        status: "SUCCEEDED",
        method: "CARD",
        createdAt: periodStart,
      },
    });
  }

  // 2) Bruno — BUSINESS annuel actif
  const brunoSub = await prisma.subscription.create({
    data: {
      userId: bruno.id,
      stripeCustomerId: "cus_demo_bruno",
      stripeSubscriptionId: "sub_demo_bruno",
      stripePriceId: process.env.STRIPE_PRICE_ID_BUSINESS_YEAR || "price_sim_BUSINESS_YEAR",
      planCode: "BUSINESS",
      interval: "YEAR",
      status: "ACTIVE",
      amountCents: priceCents("BUSINESS", "YEAR"),
      currency: "eur",
      currentPeriodStart: ago(40),
      currentPeriodEnd: ahead(325),
      lastPaymentStatus: "paid",
      lastPaymentAt: ago(40),
      lastStripeEventId: "evt_demo_bruno",
      lastStripeEventAt: ago(40),
    },
  });
  const brunoInvoice = await prisma.invoice.create({
    data: {
      userId: bruno.id,
      subscriptionId: brunoSub.id,
      stripeInvoiceId: "in_demo_bruno_1",
      number: `AIBOS-${now.getFullYear()}-2001`,
      status: "PAID",
      paymentMethod: "CARD",
      planCode: "BUSINESS",
      interval: "YEAR",
      amountDue: priceCents("BUSINESS", "YEAR"),
      amountPaid: priceCents("BUSINESS", "YEAR"),
      currency: "eur",
      periodStart: ago(40),
      periodEnd: ahead(325),
      paidAt: ago(40),
      hostedInvoiceUrl: "https://invoice.stripe.com/i/in_demo_bruno_1",
      invoicePdfUrl: "https://pay.stripe.com/invoice/in_demo_bruno_1/pdf",
      createdAt: ago(40),
    },
  });
  await prisma.payment.create({
    data: {
      userId: bruno.id,
      invoiceId: brunoInvoice.id,
      stripePaymentIntentId: "pi_demo_bruno_1",
      stripeChargeId: "ch_demo_bruno_1",
      amount: priceCents("BUSINESS", "YEAR"),
      currency: "eur",
      status: "SUCCEEDED",
      method: "CARD",
      createdAt: ago(40),
    },
  });

  // 3) Chloé — STARTER en retard de paiement (accès en période de grâce)
  const chloeSub = await prisma.subscription.create({
    data: {
      userId: chloe.id,
      stripeCustomerId: "cus_demo_chloe",
      stripeSubscriptionId: "sub_demo_chloe",
      stripePriceId: process.env.STRIPE_PRICE_ID_STARTER_MONTH || "price_sim_STARTER_MONTH",
      planCode: "STARTER",
      interval: "MONTH",
      status: "PAST_DUE",
      amountCents: priceCents("STARTER", "MONTH"),
      currency: "eur",
      currentPeriodStart: ago(32),
      currentPeriodEnd: ago(2),
      lastPaymentStatus: "failed",
      lastFailureCode: "card_declined",
      lastFailureMessage: "Carte refusée par la banque émettrice (generic_decline).",
      lastFailureAt: ago(2),
      lastStripeEventId: "evt_demo_chloe_failed",
      lastStripeEventAt: ago(2),
    },
  });
  const chloeInvoice = await prisma.invoice.create({
    data: {
      userId: chloe.id,
      subscriptionId: chloeSub.id,
      stripeInvoiceId: "in_demo_chloe_failed",
      number: `AIBOS-${now.getFullYear()}-3001`,
      status: "OPEN",
      paymentMethod: "CARD",
      planCode: "STARTER",
      interval: "MONTH",
      amountDue: priceCents("STARTER", "MONTH"),
      amountPaid: 0,
      currency: "eur",
      periodStart: ago(2),
      periodEnd: ahead(28),
      hostedInvoiceUrl: "https://invoice.stripe.com/i/in_demo_chloe_failed",
      createdAt: ago(2),
    },
  });
  await prisma.payment.create({
    data: {
      userId: chloe.id,
      invoiceId: chloeInvoice.id,
      stripePaymentIntentId: "pi_demo_chloe_failed",
      amount: priceCents("STARTER", "MONTH"),
      currency: "eur",
      status: "FAILED",
      method: "CARD",
      failureCode: "card_declined",
      failureMessage: "Carte refusée par la banque émettrice (generic_decline).",
      createdAt: ago(2),
    },
  });

  // 4) David — PRO annulé (rétention), accès terminé
  await prisma.subscription.create({
    data: {
      userId: david.id,
      stripeCustomerId: "cus_demo_david",
      stripeSubscriptionId: "sub_demo_david",
      stripePriceId: process.env.STRIPE_PRICE_ID_PRO_MONTH || "price_sim_PRO_MONTH",
      planCode: "PRO",
      interval: "MONTH",
      status: "CANCELED",
      amountCents: priceCents("PRO", "MONTH"),
      currency: "eur",
      currentPeriodStart: ago(58),
      currentPeriodEnd: ago(28),
      canceledAt: ago(35),
      endedAt: ago(28),
      cancelAtPeriodEnd: false,
      lastPaymentStatus: "paid",
      lastPaymentAt: ago(58),
      lastStripeEventId: "evt_demo_david",
      lastStripeEventAt: ago(28),
    },
  });
  await prisma.auditLog.create({
    data: {
      actorType: "STRIPE",
      action: "subscription.deleted",
      targetType: "subscription",
      targetId: "sub_demo_david",
      userId: david.id,
      createdAt: ago(28),
    },
  });

  // 5) Emma — aucun abonnement (parcours de conversion à démontrer)
  void emma;

  // 6) Farid — facture de virement en attente de confirmation administrative
  const faridSub = await prisma.subscription.create({
    data: {
      userId: farid.id,
      planCode: "PRO",
      interval: "MONTH",
      status: "INCOMPLETE",
      amountCents: priceCents("PRO", "MONTH"),
      currency: "eur",
      lastPaymentStatus: "pending",
    },
  });
  const reference = "AIB-" + now.getFullYear() + "-B7C41A2F";
  await prisma.invoice.create({
    data: {
      userId: farid.id,
      subscriptionId: faridSub.id,
      number: reference,
      status: "AWAITING_BANK_TRANSFER",
      paymentMethod: "BANK_TRANSFER",
      planCode: "PRO",
      interval: "MONTH",
      amountDue: priceCents("PRO", "MONTH"),
      amountPaid: 0,
      currency: "eur",
      periodStart: ago(1),
      periodEnd: ahead(29),
      bankTransferReference: reference,
      bankTransferInstructions: {
        accountHolder: process.env.BANK_ACCOUNT_HOLDER ?? "",
        bankName: process.env.BANK_NAME ?? "",
        iban: process.env.BANK_IBAN ?? "",
        bic: process.env.BANK_BIC ?? "",
        reference,
        amount: `${(priceCents("PRO", "MONTH") / 100).toFixed(2)} EUR`,
        plan: `${PLANS.PRO.name} — mensuel`,
        warning: "Indiquez impérativement la référence dans le libellé du virement.",
      },
      createdAt: ago(1),
    },
  });

  await prisma.auditLog.create({
    data: {
      actorType: "ADMIN",
      actorId: owner.id,
      action: "seed.initial_data_loaded",
      targetType: "platform",
      metadata: { users: 7, subscriptions: 5, invoices: 6, payments: 6 },
    },
  });

  console.log("✓ Données de démonstration créées :");
  console.log("   • Propriétaire :", owner.email);
  console.log("   • Clients : alice (PRO actif), bruno (BUSINESS annuel), chloé (en retard), david (annulé), emma (sans abonnement), farid (virement en attente)");
  const interval: BillingIntervalKey = "MONTH";
  console.log(`   • Prix appliqués : STARTER ${priceCents("STARTER", interval) / 100} €, PRO ${priceCents("PRO", interval) / 100} €, BUSINESS ${priceCents("BUSINESS", interval) / 100} €`);
}

main()
  .catch((error) => {
    console.error("Échec du peuplement :", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

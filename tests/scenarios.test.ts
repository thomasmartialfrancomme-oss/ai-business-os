import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  app,
  badSignature,
  createUser,
  currentWebhookSecret,
  deliverEvent,
  payCheckout,
  renew,
  resetDatabase,
  staleSignature,
  startCheckout,
  subscribe,
} from "./helpers";

/**
 * ══════════════════════════════════════════════════════════════════════════════
 *  SCÉNARIOS DE PAIEMENT — tests d'intégration sur base PostgreSQL réelle
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Chaque scénario traverse le chemin de code de production :
 *   service de facturation → passerelle (simulation) → événements signés
 *   → POST /api/stripe/webhook (même fonction que la route) → écriture en base.
 *
 * Couverture demandée : paiement réussi, paiement refusé, abonnement créé,
 * abonnement renouvelé, paiement échoué, annulation, changement de forfait,
 * remboursement, webhook invalide, webhook répété (+ cas limites de sécurité).
 */

const PLAN = { STARTER: "STARTER", PRO: "PRO", BUSINESS: "BUSINESS" } as const;

describe("Scénarios de paiement Stripe (mode simulation + pipeline webhook réel)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  after(async () => {
    const { prisma } = await app();
    await prisma.$disconnect();
  });

  test("1. Paiement réussi → abonnement créé et activé uniquement via les webhooks", async () => {
    const { prisma } = await app();
    const user = await createUser("client1@test.fr", "Client Un");

    // Phase 1 — le client ouvre le paiement : simple intention, aucun droit d'accès
    const checkout = await startCheckout({ user, planCode: PLAN.PRO, interval: "MONTH" });
    const intent = await prisma.subscription.findUnique({ where: { userId: user.id } });
    assert.ok(intent, "une intention d'abonnement est créée au moment du checkout");
    assert.equal(intent!.status, "INCOMPLETE", "aucun accès avant confirmation du paiement");
    assert.equal(checkout.amountCents, 5900, "le montant du checkout est calculé côté serveur");

    const { hasAccess: accessBefore } = await import("../src/lib/access");
    assert.equal(accessBefore(intent).allowed, false, "aucun accès tant que le paiement n'est pas confirmé");

    // Phase 2 — paiement puis webhooks signés
    const { deliveries } = await payCheckout(checkout.sessionId, "success");
    assert.ok(deliveries.every((delivery) => delivery.status === 200), "tous les webhooks doivent être acceptés");

    const subscription = await prisma.subscription.findUnique({ where: { userId: user.id } });
    assert.equal(subscription!.status, "ACTIVE");
    assert.equal(subscription!.planCode, "PRO");
    assert.equal(subscription!.amountCents, 5900);
    assert.ok(subscription!.stripeCustomerId?.startsWith("cus_"));
    assert.ok(subscription!.stripeSubscriptionId?.startsWith("sub_"));
    assert.equal(subscription!.lastPaymentStatus, "paid");
    assert.ok(subscription!.currentPeriodStart instanceof Date);
    assert.ok(subscription!.currentPeriodEnd!.getTime() > Date.now(), "la période couvre le mois à venir");

    // Facture + paiement enregistrés, sans aucune donnée de carte
    const invoice = await prisma.invoice.findFirst({ where: { userId: user.id } });
    assert.equal(invoice!.status, "PAID");
    assert.equal(invoice!.amountPaid, 5900);
    assert.equal(invoice!.paymentMethod, "CARD");

    const payment = await prisma.payment.findFirst({ where: { userId: user.id } });
    assert.equal(payment!.status, "SUCCEEDED");
    assert.equal(payment!.amount, 5900);
    assert.ok(payment!.stripePaymentIntentId?.startsWith("pi_"));

    // Les trois événements Stripe attendus ont été traités
    const events = await prisma.webhookEvent.findMany({ orderBy: { receivedAt: "asc" } });
    const types = events.map((event) => event.type);
    assert.ok(types.includes("checkout.session.completed"));
    assert.ok(types.includes("customer.subscription.created"));
    assert.ok(types.includes("invoice.paid"));
    assert.ok(events.every((event) => event.status === "PROCESSED"));

    // Accès accordé
    const { hasAccess } = await import("../src/lib/access");
    assert.equal(hasAccess(subscription).allowed, true);
  });

  test("2. Règle absolue : sans webhook confirmé, la page de retour n'active rien", async () => {
    const { prisma, service } = await app();
    const user = await createUser("client2@test.fr");

    // Simulation d'un client qui revient du checkout SANS que Stripe ait confirmé
    await service.createSubscriptionCheckout({ user, planCode: PLAN.PRO, interval: "MONTH", origin: "http://localhost:3000" });

    const subscription = await prisma.subscription.findUnique({ where: { userId: user.id } });
    assert.equal(subscription!.status, "INCOMPLETE");

    const { hasAccess } = await import("../src/lib/access");
    assert.equal(hasAccess(subscription).allowed, false, "aucun accès sans confirmation serveur du paiement");

    const invoices = await prisma.invoice.count({ where: { userId: user.id } });
    const payments = await prisma.payment.count({ where: { userId: user.id } });
    assert.equal(invoices, 0);
    assert.equal(payments, 0);
  });

  test("3. checkout.session.completed avec payment_status=unpaid n'accorde aucun accès", async () => {
    const { prisma, service, fixtures } = await app();
    const user = await createUser("client3@test.fr");
    const checkout = await service.createSubscriptionCheckout({
      user,
      planCode: PLAN.PRO,
      interval: "MONTH",
      origin: "http://localhost:3000",
    });

    // Événement de session terminée mais NON payée (ex. virement différé du côté Stripe)
    const event = fixtures.buildEvent("checkout.session.completed", {
      id: checkout.sessionId,
      object: "checkout.session",
      mode: "subscription",
      status: "complete",
      payment_status: "unpaid",
      customer: "cus_unpaid",
      subscription: "sub_unpaid",
      payment_intent: null,
      client_reference_id: user.id,
      metadata: { user_id: user.id, plan_code: "PRO", interval: "MONTH" },
      amount_total: 5900,
      currency: "eur",
      created: Math.floor(Date.now() / 1000),
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });

    const result = await deliverEvent(event);
    assert.equal(result.status, 200);

    const subscription = await prisma.subscription.findUnique({ where: { userId: user.id } });
    assert.equal(subscription!.status, "INCOMPLETE", "un paiement non confirmé ne peut pas activer un abonnement");

    const { hasAccess } = await import("../src/lib/access");
    assert.equal(hasAccess(subscription).allowed, false);
  });

  test("4. Paiement refusé → aucun accès, facture ouverte, paiement en échec", async () => {
    const { prisma } = await app();
    const user = await createUser("client4@test.fr");

    const { deliveries } = await subscribe({ user, planCode: PLAN.PRO, outcome: "declined" });
    assert.ok(deliveries.every((delivery) => delivery.status === 200));

    const subscription = await prisma.subscription.findUnique({ where: { userId: user.id } });
    assert.notEqual(subscription!.status, "ACTIVE");
    assert.ok(subscription!.stripeSubscriptionId === null, "aucun abonnement Stripe créé sur un refus");

    const invoice = await prisma.invoice.findFirst({ where: { userId: user.id } });
    assert.equal(invoice!.status, "OPEN", "la facture reste en attente de paiement");

    const payment = await prisma.payment.findFirst({ where: { userId: user.id } });
    assert.equal(payment!.status, "FAILED");
    assert.equal(payment!.failureCode, "card_declined");

    const events = await prisma.webhookEvent.findMany();
    assert.ok(events.map((event) => event.type).includes("invoice.payment_failed"));

    const { hasAccess } = await import("../src/lib/access");
    assert.equal(hasAccess(subscription).allowed, false, "un paiement refusé ne donne jamais accès");
  });

  test("5. Renouvellement d'abonnement → période prolongée et nouvelle facture payée", async () => {
    const { prisma } = await app();
    const user = await createUser("client5@test.fr");
    await subscribe({ user, planCode: PLAN.STARTER, interval: "MONTH" });

    const first = await prisma.subscription.findUnique({ where: { userId: user.id } });
    const firstPeriodEnd = first!.currentPeriodEnd!;

    const { deliveries } = await renew(first!.stripeSubscriptionId!, "success");
    assert.ok(deliveries.every((delivery) => delivery.status === 200));

    const renewed = await prisma.subscription.findUnique({ where: { userId: user.id } });
    assert.equal(renewed!.status, "ACTIVE");
    assert.ok(renewed!.currentPeriodEnd!.getTime() > firstPeriodEnd.getTime(), "la fin de période est repoussée");
    assert.equal(renewed!.lastPaymentStatus, "paid");

    const paidInvoices = await prisma.invoice.count({ where: { userId: user.id, status: "PAID" } });
    assert.equal(paidInvoices, 2, "l'échéance renouvelée produit une seconde facture payée");

    const payments = await prisma.payment.findMany({ where: { userId: user.id, status: "SUCCEEDED" } });
    assert.equal(payments.length, 2);
    assert.equal(payments.reduce((sum, payment) => sum + payment.amount, 0), 5800, "2 × 29 € encaissés");
  });

  test("6. Paiement échoué au renouvellement → past_due, grâce puis suspension", async () => {
    const { prisma } = await app();
    const user = await createUser("client6@test.fr");
    await subscribe({ user, planCode: PLAN.PRO, interval: "MONTH" });
    const subscription = await prisma.subscription.findUnique({ where: { userId: user.id } });
    const { hasAccess } = await import("../src/lib/access");

    const { deliveries } = await renew(subscription!.stripeSubscriptionId!, "failed");
    assert.ok(deliveries.every((delivery) => delivery.status === 200));

    const pastDue = await prisma.subscription.findUnique({ where: { userId: user.id } });
    assert.equal(pastDue!.status, "PAST_DUE");
    assert.equal(pastDue!.lastPaymentStatus, "failed");
    assert.equal(pastDue!.lastFailureCode, "card_declined");
    assert.ok(pastDue!.lastFailureAt instanceof Date);

    // Accès maintenu pendant la période de grâce (par défaut 3 jours)
    const decision = hasAccess(pastDue);
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, "past_due_grace");

    // Le paiement échoué est tracé côté paiements
    const failed = await prisma.payment.findFirst({ where: { userId: user.id, status: "FAILED" } });
    assert.ok(failed);

    // Après la grâce, l'accès est coupé automatiquement (aucune écriture requise)
    const afterGrace = hasAccess({ ...pastDue!, currentPeriodEnd: new Date(Date.now() - 10 * 86400000) });
    assert.equal(afterGrace.allowed, false);
  });

  test("7. Annulation en fin de période, puis résiliation effective", async () => {
    const { prisma, service, gateway, events, fixtures } = await app();
    const user = await createUser("client7@test.fr");
    await subscribe({ user, planCode: PLAN.PRO, interval: "MONTH" });
    const { hasAccess } = await import("../src/lib/access");

    // Demande d'annulation : programmée en fin de période
    await service.cancelSubscription({ user });
    const scheduled = await prisma.subscription.findUnique({ where: { userId: user.id } });
    assert.equal(scheduled!.cancelAtPeriodEnd, true);
    assert.equal(scheduled!.status, "ACTIVE", "l'accès reste actif jusqu'à la fin de la période payée");
    assert.equal(hasAccess(scheduled).allowed, true);
    assert.equal(hasAccess(scheduled).reason, "cancel_at_period_end");

    // Fin de période : Stripe émet customer.subscription.deleted
    const subscribed = await prisma.subscription.findUnique({ where: { userId: user.id } });
    const deletedEvent = fixtures.buildEvent(
      "customer.subscription.deleted",
      fixtures.buildSubscription({
        id: subscribed!.stripeSubscriptionId!,
        customer: subscribed!.stripeCustomerId!,
        status: "canceled",
        planCode: "PRO",
        interval: "MONTH",
        priceId: "price_sim_PRO_MONTH",
        canceledAt: Math.floor(Date.now() / 1000),
        endedAt: Math.floor(Date.now() / 1000),
      })
    );
    const result = await deliverEvent(deletedEvent);
    assert.equal(result.status, 200);

    const canceled = await prisma.subscription.findUnique({ where: { userId: user.id } });
    assert.equal(canceled!.status, "CANCELED");
    assert.ok(canceled!.canceledAt instanceof Date);
    assert.equal(hasAccess(canceled).allowed, false, "plus d'accès après la résiliation effective");
    void events;
    void gateway;
  });

  test("8. Changement de forfait → nouveau plan appliqué et prorata facturé", async () => {
    const { prisma, service } = await app();
    const user = await createUser("client8@test.fr");
    await subscribe({ user, planCode: PLAN.STARTER, interval: "MONTH" });

    const result = await service.changePlan({ user, planCode: PLAN.PRO, interval: "MONTH", origin: "http://localhost:3000" });
    assert.equal(result.planCode, "PRO");
    assert.equal(result.prorated, true, "une montée en gamme est facturée au prorata");

    const subscription = await prisma.subscription.findUnique({ where: { userId: user.id } });
    assert.equal(subscription!.planCode, "PRO");
    assert.equal(subscription!.amountCents, 5900);

    const audit = await prisma.auditLog.findFirst({ where: { action: "subscription.plan_changed" } });
    assert.ok(audit, "le changement de forfait est journalisé");

    // Descente en gamme : sans prorata (effet au renouvellement)
    const downgrade = await service.changePlan({ user, planCode: PLAN.STARTER, interval: "MONTH", origin: "http://localhost:3000" });
    assert.equal(downgrade.prorated, false);
    const back = await prisma.subscription.findUnique({ where: { userId: user.id } });
    assert.equal(back!.amountCents, 2900);
  });

  test("9. Remboursement → paiement et facture remboursés, accès inchangé", async () => {
    const { prisma, gateway, events, service } = await app();
    const user = await createUser("client9@test.fr");
    await subscribe({ user, planCode: PLAN.PRO, interval: "MONTH" });

    const payment = await prisma.payment.findFirst({ where: { userId: user.id } });
    const outcome = await gateway.refund({ paymentIntentId: payment!.stripePaymentIntentId! });
    const deliveries = await events.deliverEvents(outcome.events);
    assert.ok(deliveries.every((delivery) => delivery.status === 200));

    const refunded = await prisma.payment.findFirst({ where: { userId: user.id } });
    assert.equal(refunded!.status, "REFUNDED");
    assert.equal(refunded!.amountRefunded, 5900);

    const invoice = await prisma.invoice.findFirst({ where: { userId: user.id } });
    assert.equal(invoice!.status, "REFUNDED");

    const audit = await prisma.auditLog.findFirst({ where: { action: "payment.refunded" } });
    assert.ok(audit, "le remboursement est journalisé");

    // Un remboursement ne coupe pas l'accès : la décision commerciale reste humaine
    const subscription = await prisma.subscription.findUnique({ where: { userId: user.id } });
    assert.equal(subscription!.status, "ACTIVE");
    void service;
  });

  test("10. Virement bancaire : aucun accès avant confirmation administrative", async () => {
    const { prisma, bankTransfer } = await app();
    const owner = await createUser("proprietaire@test.fr", "Propriétaire", "OWNER");
    const client = await createUser("client10@test.fr", "Cabinet Client SARL");

    await bankTransfer.saveBankDetails(owner, {
      accountHolder: "AI Business OS SAS",
      bankName: "Banque Test",
      iban: "FR7630006000011234567890189",
      bic: "AGRIFRPPXXX",
    });

    // 1) Facture émise en attente de virement
    const created = await bankTransfer.createBankTransferInvoice({ user: client, planCode: PLAN.PRO, interval: "MONTH" });
    assert.ok(created.reference.startsWith("AIB-"));

    const invoice = await prisma.invoice.findUnique({ where: { id: created.invoiceId } });
    assert.equal(invoice!.status, "AWAITING_BANK_TRANSFER");
    assert.equal(invoice!.amountPaid, 0);

    const { hasAccess } = await import("../src/lib/access");
    const pending = await prisma.subscription.findUnique({ where: { userId: client.id } });
    assert.equal(hasAccess(pending).allowed, false, "une facture virement en attente ne donne aucun accès");

    // 2) Déclaration du client : le statut ne change pas
    await bankTransfer.declareBankTransfer({ user: client, invoiceId: created.invoiceId, reference: created.reference, note: "virement émis" });
    const declared = await prisma.invoice.findUnique({ where: { id: created.invoiceId } });
    assert.equal(declared!.status, "AWAITING_BANK_TRANSFER", "une déclaration de client ne vaut pas paiement");
    assert.ok(declared!.bankTransferDeclaredAt instanceof Date);

    // 3) Confirmation refusée avec une mauvaise référence
    await assert.rejects(
      () => bankTransfer.confirmBankTransfer({ owner, invoiceId: created.invoiceId, reference: "AIB-FAUX-0000" }),
      /Référence de virement incorrecte/
    );

    // 4) Confirmation administrative valide → PAID + activation
    const confirmed = await bankTransfer.confirmBankTransfer({
      owner,
      invoiceId: created.invoiceId,
      reference: created.reference,
      note: "crédit reçu le jour même",
    });
    assert.equal(confirmed.status, "PAID");
    assert.equal(confirmed.subscriptionStatus, "ACTIVE");

    const paid = await prisma.invoice.findUnique({ where: { id: created.invoiceId } });
    assert.equal(paid!.status, "PAID");
    assert.equal(paid!.amountPaid, 5900);
    assert.equal(paid!.bankTransferConfirmedBy, owner.email);

    const activated = await prisma.subscription.findUnique({ where: { userId: client.id } });
    assert.equal(activated!.status, "ACTIVE");
    assert.ok(activated!.currentPeriodEnd!.getTime() > Date.now());
    assert.equal(hasAccess(activated).allowed, true);

    const payment = await prisma.payment.findFirst({ where: { userId: client.id } });
    assert.equal(payment!.method, "BANK_TRANSFER");
    assert.equal(payment!.status, "SUCCEEDED");

    // 5) Double confirmation impossible
    await assert.rejects(
      () => bankTransfer.confirmBankTransfer({ owner, invoiceId: created.invoiceId, reference: created.reference }),
      /déjà marquée payée/
    );
  });

  test("11. Webhook invalide : signature refusée, aucune écriture", async () => {
    const { prisma, fixtures } = await app();
    await createUser("client11@test.fr");

    const event = fixtures.buildEvent("invoice.paid", { id: "in_forged", object: "invoice" });
    const payload = JSON.stringify(event);

    const result = await deliverEvent(event, { signature: badSignature(payload) });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, "invalid_signature");

    assert.equal(await prisma.webhookEvent.count(), 0, "un webhook non authentifié n'est même pas enregistré");
    const audit = await prisma.auditLog.findFirst({ where: { action: "webhook.signature_invalid" } });
    assert.ok(audit, "la tentative est journalisée pour analyse");
  });

  test("12. Webhook invalide : signature expirée (protection contre le rejeu)", async () => {
    const { prisma, fixtures } = await app();
    const secret = await currentWebhookSecret();
    assert.ok(secret.startsWith("whsec_"), "le secret de webhook doit exister en mode simulation");

    const event = fixtures.buildEvent("invoice.paid", { id: "in_stale", object: "invoice" });
    const payload = JSON.stringify(event);

    const result = await deliverEvent(event, { signature: staleSignature(payload, secret) });
    assert.equal(result.status, 400);
    assert.equal(await prisma.webhookEvent.count(), 0);
  });

  test("13. Webhook répété : idempotence totale (aucun double effet)", async () => {
    const { prisma, fixtures } = await app();
    const user = await createUser("client13@test.fr");
    await subscribe({ user, planCode: PLAN.PRO, interval: "MONTH" });

    const invoicesBefore = await prisma.invoice.count({ where: { userId: user.id } });
    const paymentsBefore = await prisma.payment.count({ where: { userId: user.id } });
    const subscriptionBefore = await prisma.subscription.findUnique({ where: { userId: user.id } });

    // On rejoue le dernier événement invoice.paid reçu
    const stored = await prisma.webhookEvent.findFirst({ where: { type: "invoice.paid" }, orderBy: { receivedAt: "desc" } });
    const replayed = stored!.payload as unknown as Parameters<typeof deliverEvent>[0];
    const first = await deliverEvent(replayed);
    const second = await deliverEvent(replayed);
    const third = await deliverEvent(replayed);

    assert.equal(first.status, 200);
    assert.equal(first.body.duplicate, true);
    assert.equal(second.body.duplicate, true);
    assert.equal(third.body.duplicate, true);

    assert.equal(await prisma.invoice.count({ where: { userId: user.id } }), invoicesBefore, "aucune facture dupliquée");
    assert.equal(await prisma.payment.count({ where: { userId: user.id } }), paymentsBefore, "aucun paiement dupliqué");

    const subscriptionAfter = await prisma.subscription.findUnique({ where: { userId: user.id } });
    assert.equal(subscriptionAfter!.status, subscriptionBefore!.status);

    const ignored = await prisma.auditLog.count({ where: { action: "webhook.duplicate_ignored" } });
    assert.equal(ignored, 3, "chaque rejeu est journalisé");
    void fixtures;
  });

  test("14. Événement hors ordre : un statut plus ancien ne peut pas régresser l'abonnement", async () => {
    const { prisma, fixtures } = await app();
    const user = await createUser("client14@test.fr");
    await subscribe({ user, planCode: PLAN.PRO, interval: "MONTH" });
    const subscription = await prisma.subscription.findUnique({ where: { userId: user.id } });

    // Événement « past_due » daté d'hier (livraison retardée par Stripe)
    const staleEvent = fixtures.buildEvent(
      "customer.subscription.updated",
      fixtures.buildSubscription({
        id: subscription!.stripeSubscriptionId!,
        customer: subscription!.stripeCustomerId!,
        status: "past_due",
        planCode: "PRO",
        interval: "MONTH",
        priceId: "price_sim_PRO_MONTH",
      })
    );
    staleEvent.created = Math.floor(Date.now() / 1000) - 86_400; // hier

    const result = await deliverEvent(staleEvent);
    assert.equal(result.status, 200);

    const unchanged = await prisma.subscription.findUnique({ where: { userId: user.id } });
    assert.equal(unchanged!.status, "ACTIVE", "un événement obsolète ne doit pas dégrader l'état");

    const audit = await prisma.auditLog.findFirst({ where: { action: "stripe.event.out_of_order_ignored" } });
    assert.ok(audit, "l'événement ignoré est tracé");
  });

  test("15. Cohérence des indicateurs : MRR / ARR calculés depuis les abonnements actifs", async () => {
    const { prisma } = await app();
    const metrics = await import("../src/lib/payments/metrics");

    const userA = await createUser("mrr-a@test.fr");
    const userB = await createUser("mrr-b@test.fr");
    const userC = await createUser("mrr-c@test.fr");

    await subscribe({ user: userA, planCode: PLAN.PRO, interval: "MONTH" }); // 59 €/mois
    await subscribe({ user: userB, planCode: PLAN.BUSINESS, interval: "YEAR" }); // 950 €/an → 7917 c./mois
    await subscribe({ user: userC, planCode: PLAN.STARTER, interval: "MONTH", outcome: "declined" }); // refusé

    const result = await metrics.computeRevenueMetrics();

    const expectedMrr = 5900 + Math.round(95000 / 12);
    assert.equal(result.mrrCents, expectedMrr);
    assert.equal(result.arrCents, expectedMrr * 12);
    assert.equal(result.activeSubscriptions, 2, "le paiement refusé ne compte pas comme abonnement actif");
    assert.equal(result.monthRevenueCents, 5900 + 95000, "encaissements du mois = PRO mensuel + BUSINESS annuel");
    assert.equal(result.failedPaymentsThisMonth, 1);
    assert.equal(result.currency, "eur");
    assert.equal(result.timeline.length, 6);
    void prisma;
  });
});

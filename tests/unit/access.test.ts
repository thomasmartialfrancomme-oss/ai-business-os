import { test } from "node:test";
import assert from "node:assert/strict";
import "../helpers";

/**
 * Tests unitaires de la règle d'accès : c'est la fonction qui décide si un client
 * peut utiliser AI Business OS. Elle ne lit que la base, jamais le navigateur.
 */

type FakeSubscription = Parameters<typeof import("../../src/lib/access").hasAccess>[0];

function subscription(overrides: Partial<NonNullable<FakeSubscription>>): NonNullable<FakeSubscription> {
  return {
    id: "sub_test",
    userId: "user_test",
    stripeCustomerId: "cus_test",
    stripeSubscriptionId: "sub_stripe_test",
    stripePriceId: "price_test",
    planCode: "PRO",
    interval: "MONTH",
    status: "ACTIVE",
    currentPeriodStart: new Date(Date.now() - 5 * 86400000),
    currentPeriodEnd: new Date(Date.now() + 25 * 86400000),
    cancelAtPeriodEnd: false,
    lastPaymentStatus: "paid",
    lastPaymentAt: new Date(Date.now() - 5 * 86400000),
    amountCents: 5900,
    currency: "eur",
    pendingPlanCode: null,
    pendingInterval: null,
    lastFailureCode: null,
    lastFailureMessage: null,
    lastFailureAt: null,
    canceledAt: null,
    endedAt: null,
    lastStripeEventId: null,
    lastStripeEventAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as NonNullable<FakeSubscription>;
}

test("aucun abonnement : accès refusé", async () => {
  const { hasAccess } = await import("../../src/lib/access");
  const decision = hasAccess(null);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "no_subscription");
});

test("abonnement actif : accès accordé jusqu'à la fin de période", async () => {
  const { hasAccess } = await import("../../src/lib/access");
  const decision = hasAccess(subscription({}));
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "active");
});

test("résiliation programmée : accès maintenu jusqu'à l'échéance payée", async () => {
  const { hasAccess } = await import("../../src/lib/access");
  const beforeEnd = hasAccess(subscription({ cancelAtPeriodEnd: true }));
  assert.equal(beforeEnd.allowed, true);
  assert.equal(beforeEnd.reason, "cancel_at_period_end");

  const afterEnd = hasAccess(
    subscription({ cancelAtPeriodEnd: true, currentPeriodEnd: new Date(Date.now() - 86400000) })
  );
  assert.equal(afterEnd.allowed, false);
  assert.equal(afterEnd.reason, "canceled");
});

test("paiement échoué : période de grâce puis suspension", async () => {
  const { hasAccess } = await import("../../src/lib/access");

  // Échec récent : encore dans la fenêtre de grâce (3 jours par défaut)
  const inGrace = hasAccess(
    subscription({ status: "PAST_DUE", currentPeriodEnd: new Date(Date.now() - 86400000), lastFailureAt: new Date() })
  );
  assert.equal(inGrace.allowed, true);
  assert.equal(inGrace.reason, "past_due_grace");
  assert.ok((inGrace.graceDaysRemaining ?? 0) >= 0);

  // Échec ancien : au-delà de la grâce, l'accès est coupé
  const expired = hasAccess(
    subscription({ status: "PAST_DUE", currentPeriodEnd: new Date(Date.now() - 10 * 86400000) })
  );
  assert.equal(expired.allowed, false);
});

test("statuts terminaux : aucun accès", async () => {
  const { hasAccess } = await import("../../src/lib/access");
  for (const status of ["CANCELED", "UNPAID", "INCOMPLETE", "INCOMPLETE_EXPIRED", "PAUSED"] as const) {
    const decision = hasAccess(subscription({ status }));
    assert.equal(decision.allowed, false, `statut ${status} ne doit pas donner accès`);
  }
});

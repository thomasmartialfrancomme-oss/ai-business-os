import { test } from "node:test";
import assert from "node:assert/strict";
import "../helpers";

/**
 * Tests unitaires du catalogue et de la tarification.
 * Aucun accès base de données : uniquement du calcul de montants.
 */

test("les trois offres ont les tarifs demandés (29 €, 59 €, 99 €/mois)", async () => {
  const plans = await import("../../src/lib/plans");
  assert.equal(plans.PLANS.STARTER.monthlyCents, 2900);
  assert.equal(plans.PLANS.PRO.monthlyCents, 5900);
  assert.equal(plans.PLANS.BUSINESS.monthlyCents, 9900);
  assert.deepEqual([...plans.PLAN_CODES], ["STARTER", "PRO", "BUSINESS"]);
});

test("le prix annuel applique la réduction configurable (20 % par défaut)", async () => {
  const plans = await import("../../src/lib/plans");
  assert.equal(plans.annualDiscountPercent(), 20);

  // PRO : 59 € × 12 = 708 € → −20 % = 566,40 € → arrondi à l'euro inférieur = 566 €
  assert.equal(plans.priceCents("PRO", "YEAR"), 56600);
  // BUSINESS : 99 € × 12 = 1188 € → −20 % = 950,40 € → 950 €
  assert.equal(plans.priceCents("BUSINESS", "YEAR"), 95000);
  // STARTER : 29 € × 12 = 348 € → −20 % = 278,40 € → 278 €
  assert.equal(plans.priceCents("STARTER", "YEAR"), 27800);
  assert.equal(plans.priceCents("PRO", "MONTH"), 5900);
});

test("la réduction annuelle est modifiable par variable d'environnement", async () => {
  const plans = await import("../../src/lib/plans");
  const previous = process.env.ANNUAL_DISCOUNT_PERCENT;
  process.env.ANNUAL_DISCOUNT_PERCENT = "50";
  assert.equal(plans.annualDiscountPercent(), 50);
  assert.equal(plans.priceCents("PRO", "YEAR"), 35400); // 708 € − 50 % = 354 €
  process.env.ANNUAL_DISCOUNT_PERCENT = previous;
});

test("l'équivalent mensuel d'un abonnement annuel sert au calcul du MRR", async () => {
  const plans = await import("../../src/lib/plans");
  assert.equal(plans.monthlyEquivalentCents("PRO", "MONTH"), 5900);
  assert.equal(plans.monthlyEquivalentCents("PRO", "YEAR"), Math.round(56600 / 12)); // ≈ 4717
  assert.equal(plans.monthlyEquivalentCents("BUSINESS", "YEAR"), Math.round(95000 / 12));
});

test("le catalogue est protégé contre les valeurs inconnues", async () => {
  const plans = await import("../../src/lib/plans");
  assert.equal(plans.isPlanCode("PRO"), true);
  assert.equal(plans.isPlanCode("pro"), false);
  assert.equal(plans.isPlanCode("ENTERPRISE"), false);
  assert.equal(plans.isPlanCode(undefined), false);
  assert.equal(plans.isBillingInterval("YEAR"), true);
  assert.equal(plans.isBillingInterval("WEEKLY"), false);
});

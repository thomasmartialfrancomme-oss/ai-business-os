import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";
import { PLANS, PLAN_CODES, annualDiscountPercent, priceCents } from "@/lib/plans";
import { Alert } from "@/components/ui";
import { PlanSelector, type PlanCardData } from "@/components/PlanSelector";

export const dynamic = "force-dynamic";

/**
 * Page tarifs : sélection du forfait par intervalle (mensuel / annuel avec réduction
 * configurable) puis création de la session Checkout côté serveur.
 */
export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string; interval?: string; checkout?: string }>;
}) {
  const params = await searchParams;
  const user = await getSessionUser();
  const subscription = user ? await prisma.subscription.findUnique({ where: { userId: user.id } }) : null;
  const discount = annualDiscountPercent();

  const plans: PlanCardData[] = PLAN_CODES.map((code) => {
    const plan = PLANS[code];
    const monthly = priceCents(code, "MONTH");
    const yearly = priceCents(code, "YEAR");
    return {
      code,
      name: plan.name,
      tagline: plan.tagline,
      features: plan.features,
      monthlyCents: monthly,
      yearlyCents: yearly,
      yearlyMonthlyEquivalent: Math.round(yearly / 12),
      currency: plan.currency,
      featured: Boolean(plan.featured),
      stripePriceConfigured: Boolean(process.env[`STRIPE_PRICE_ID_${code}_MONTH`]),
    };
  });

  const hasActiveSubscription = Boolean(
    subscription && ["ACTIVE", "TRIALING", "PAST_DUE"].includes(subscription.status)
  );

  return (
    <div className="container" style={{ paddingTop: 30 }}>
      <div className="row-between">
        <div>
          <h1>Tarifs AI Business OS</h1>
          <p className="muted">
            Paiement par carte via Stripe, ou par virement bancaire pour les clients professionnels. Résiliation à
            tout moment, effective en fin de période.
          </p>
        </div>
        {subscription && (
          <div className="card card-tight">
            <div className="stat-label">Votre abonnement</div>
            <div className="mt-2">
              <strong>{PLANS[subscription.planCode as keyof typeof PLANS]?.name ?? subscription.planCode}</strong>{" "}
              <span className="dim">({subscription.interval === "YEAR" ? "annuel" : "mensuel"})</span>
            </div>
            <Link href="/billing" className="btn btn-sm mt-2">
              Gérer mon abonnement
            </Link>
          </div>
        )}
      </div>

      {params.checkout === "canceled" && (
        <div className="mt-4">
          <Alert tone="warning" title="Paiement interrompu">
            Vous avez quitté la page de paiement Stripe : aucun montant n'a été prélevé et aucun abonnement n'a été
            activé.
          </Alert>
        </div>
      )}

      {!user && (
        <div className="mt-4">
          <Alert tone="info" title="Connectez-vous pour souscrire">
            Les prix sont publics, mais la création d'une session de paiement nécessite un compte :{" "}
            <Link href="/login?next=/pricing">se connecter</Link>.
          </Alert>
        </div>
      )}

      <div className="mt-6">
        <PlanSelector
          plans={plans}
          authenticated={Boolean(user)}
          hasActiveSubscription={hasActiveSubscription}
          currentPlan={subscription?.planCode ?? null}
          currentInterval={subscription?.interval ?? null}
          annualDiscountPercent={discount}
          initialPlan={params.plan ?? null}
          simulation={env.stripeMode === "simulation"}
        />
      </div>

      <div className="grid grid-2 mt-6">
        <div className="card card-tight">
          <h3>Sans engagement</h3>
          <p className="dim" style={{ marginBottom: 0 }}>
            L'annulation est programmée en fin de période : vous conservez l'accès jusqu'à la date déjà payée, et
            aucun nouveau prélèvement n'est effectué.
          </p>
        </div>
        <div className="card card-tight">
          <h3>Facturation & TVA</h3>
          <p className="dim" style={{ marginBottom: 0 }}>
            Chaque paiement génère une facture Stripe téléchargeable en PDF depuis votre espace facturation. Les
            justificatifs comptables restent disponibles même après résiliation.
          </p>
        </div>
      </div>
    </div>
  );
}

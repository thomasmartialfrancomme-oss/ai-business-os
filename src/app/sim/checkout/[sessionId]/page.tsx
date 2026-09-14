import Link from "next/link";
import { notFound } from "next/navigation";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";
import { PLANS } from "@/lib/plans";
import { Alert } from "@/components/ui";
import { formatMoney } from "@/lib/format";
import { SimCheckout } from "@/components/SimCheckout";

export const dynamic = "force-dynamic";

/**
 * Page de paiement simulée — reproduction locale de Stripe Checkout.
 *
 * Elle n'existe qu'en mode simulation. Avec une clé Stripe, le client est redirigé
 * vers checkout.stripe.com et cette page n'a plus aucune raison d'être.
 * Aucun champ de carte réel n'est présent : on choisit une carte de test Stripe.
 */
export default async function SimCheckoutPage({ params }: { params: Promise<{ sessionId: string }> }) {
  if (!env.simulationAllowed || env.stripeMode !== "simulation") notFound();

  const { sessionId } = await params;
  const row = await prisma.simObject.findUnique({ where: { id: sessionId } });
  if (!row || row.type !== "checkout_session") notFound();

  const session = row.data as Record<string, unknown>;
  const metadata = (session.metadata as Record<string, string>) ?? {};
  const plan = PLANS[metadata.plan_code as keyof typeof PLANS];
  const amount = Number(session.amount_total ?? 0);
  const currency = String(session.currency ?? "eur");
  const status = String(session.status ?? "open");

  return (
    <div className="container-narrow" style={{ paddingTop: 34 }}>
      <div className="row-between">
        <h1>Paiement sécurisé</h1>
        <Link href="/sim" className="btn btn-sm btn-ghost">
          ← Panneau de simulation
        </Link>
      </div>

      <div className="mt-4">
        <Alert tone="warning" title="Simulation locale de Stripe Checkout">
          Cette page remplace <span className="mono">checkout.stripe.com</span> en l'absence de clé Stripe. Écrire une clé
          <span className="mono"> sk_test_…</span> redirige vers la véritable page de paiement Stripe.
        </Alert>
      </div>

      <div className="card mt-4">
        <div className="row-between">
          <div>
            <div className="stat-label">Abonnement AI Business OS</div>
            <h3 className="mt-2">{plan?.name ?? metadata.plan_code}</h3>
            <p className="dim">{metadata.interval === "YEAR" ? "Facturation annuelle" : "Facturation mensuelle"}</p>
          </div>
          <div className="right">
            <div className="plan-price">{formatMoney(amount, currency)}</div>
            <div className="dim">par {metadata.interval === "YEAR" ? "an" : "mois"}, renouvellement automatique</div>
          </div>
        </div>

        <div className="divider" />

        <SimCheckout
          sessionId={sessionId}
          status={status}
          alreadyPaid={status === "complete"}
          email={String(metadata.user_id ?? "")}
        />
      </div>

      <p className="dim mt-4">
        Aucune donnée de carte n'est collectée, transmise ou stockée par AI Business OS — y compris ici : les numéros
        affichés sont les cartes de test publiques de Stripe et servent uniquement à choisir un scénario.
      </p>
    </div>
  );
}

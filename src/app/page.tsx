import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";
import { PLANS } from "@/lib/plans";
import { Alert, Badge, SectionTitle } from "@/components/ui";
import { formatMoney } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * Page d'accueil : présente le parcours de paiement et sert de point d'entrée
 * vers les écrans du module (tarifs, facturation, revenus, simulation).
 */
export default async function HomePage() {
  const user = await getSessionUser();
  const [activeSubscriptions, totalWebhooks] = await Promise.all([
    prisma.subscription.count({ where: { status: { in: ["ACTIVE", "TRIALING"] } } }),
    prisma.webhookEvent.count(),
  ]);

  return (
    <div className="container" style={{ paddingTop: 34 }}>
      <div className="row-between">
        <div className="stack" style={{ gap: 10, maxWidth: 700 }}>
          <div className="row">
            <Badge tone="badge-primary">Module paiement Stripe</Badge>
            {env.stripeMode === "simulation" ? (
              <Badge tone="badge-warning">Mode simulation — aucune clé Stripe requise</Badge>
            ) : (
              <Badge tone={env.stripeMode === "live" ? "badge-success" : "badge-info"}>
                Environnement Stripe {env.stripeMode === "live" ? "LIVE" : "TEST"}
              </Badge>
            )}
          </div>
          <h1>Abonnements AI Business OS, encaissés sur votre compte Stripe</h1>
          <p className="muted">
            Checkout Stripe côté serveur, webhooks vérifiés, activation uniquement après confirmation du paiement,
            espace facturation client, tableau de bord de revenus et option virement bancaire pour les clients
            professionnels.
          </p>
        </div>

        <div className="card card-tight" style={{ minWidth: 250 }}>
          <div className="stat-label">Plateforme</div>
          <div className="stack mt-2" style={{ gap: 6 }}>
            <div className="row-between">
              <span className="dim">Abonnements actifs</span>
              <strong>{activeSubscriptions}</strong>
            </div>
            <div className="row-between">
              <span className="dim">Webhooks reçus</span>
              <strong>{totalWebhooks}</strong>
            </div>
            <div className="row-between">
              <span className="dim">Destination des fonds</span>
              <strong>Compte Stripe du propriétaire</strong>
            </div>
          </div>
          <div className="divider" />
          {user ? (
            <div className="btn-group">
              <Link href="/billing" className="btn btn-sm btn-primary">
                Mon espace facturation
              </Link>
              {user.isOwner && (
                <Link href="/admin/revenue" className="btn btn-sm">
                  Revenus
                </Link>
              )}
            </div>
          ) : (
            <div className="btn-group">
              <Link href="/pricing" className="btn btn-sm btn-primary">
                Voir les tarifs
              </Link>
              <Link href="/login" className="btn btn-sm">
                Se connecter
              </Link>
            </div>
          )}
        </div>
      </div>

      <SectionTitle>Les trois offres</SectionTitle>
      <div className="plans">
        {Object.values(PLANS).map((plan) => (
          <div key={plan.code} className={`card plan ${plan.featured ? "card-highlight" : ""}`}>
            {plan.featured && <span className="ribbon">Le plus choisi</span>}
            <h3>{plan.name}</h3>
            <p className="dim" style={{ minHeight: 42 }}>
              {plan.tagline}
            </p>
            <div className="plan-price">
              {formatMoney(plan.monthlyCents, plan.currency)}
              <small> / mois</small>
            </div>
            <ul className="plan-features">
              {plan.features.slice(0, 4).map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
            <Link href={`/pricing?plan=${plan.code}`} className={`btn btn-block ${plan.featured ? "btn-primary" : ""}`}>
              Choisir {plan.name}
            </Link>
          </div>
        ))}
      </div>

      <SectionTitle>Le parcours d'un paiement</SectionTitle>
      <div className="grid grid-2">
        <div className="card">
          <h3>Abonnement par carte</h3>
          <ol className="step-list mt-4">
            <li>Le client choisit son forfait : une session Stripe Checkout est créée côté serveur.</li>
            <li>Il est redirigé vers Stripe et saisit sa carte chez Stripe (jamais sur nos serveurs).</li>
            <li>Retour sur <span className="mono">/billing/success</span> — qui n'active rien et se contente de constater.</li>
            <li>Stripe envoie un webhook signé à <span className="mono">/api/stripe/webhook</span>.</li>
            <li>Signature vérifiée, événement idempotent, abonnement activé en base.</li>
            <li>Le renouvellement est automatique ; les fonds arrivent sur votre compte Stripe, qui les verse sur votre compte bancaire.</li>
          </ol>
        </div>
        <div className="card">
          <h3>Abonnement par virement bancaire</h3>
          <ol className="step-list mt-4">
            <li>Le client professionnel choisit le virement : une facture est émise avec une référence unique.</li>
            <li>Statut de la facture : <span className="mono">AWAITING_BANK_TRANSFER</span> — aucun accès accordé.</li>
            <li>Il déclare son virement depuis son espace ; les coordonnées bancaires de l'administrateur sont affichées.</li>
            <li>Le propriétaire vérifie l'encaissement puis confirme depuis <span className="mono">/admin/revenue</span>.</li>
            <li>Alors seulement la facture passe à <span className="mono">PAID</span> et l'abonnement est activé.</li>
          </ol>
        </div>
      </div>

      <div className="mt-6">
        <Alert tone="info" title="Règle appliquée par le code">
          Le frontend ne peut jamais déclarer « paiement réussi ». Aucune page, aucune action navigateur, aucun cookie
          ne modifie l'état d'un paiement : seul le backend écrit la base, après vérification de la signature Stripe
          (fichier <span className="mono">src/lib/payments/state.ts</span> — unique point d'écriture).
        </Alert>
      </div>

      <SectionTitle>Démarrer</SectionTitle>
      <div className="grid grid-3">
        <div className="card card-tight">
          <h3>1. Se connecter</h3>
          <p className="dim mt-2">Choisissez un compte de démonstration : client ou propriétaire de la plateforme.</p>
          <Link href="/login" className="btn btn-sm mt-2">
            Ouvrir la connexion
          </Link>
        </div>
        <div className="card card-tight">
          <h3>2. Souscrire</h3>
          <p className="dim mt-2">Souscrivez au forfait Pro à 59 €/mois et regardez les webhooks s'enchaîner.</p>
          <Link href="/pricing" className="btn btn-sm mt-2">
            Voir les forfaits
          </Link>
        </div>
        <div className="card card-tight">
          <h3>3. Vérifier les revenus</h3>
          <p className="dim mt-2">MRR, ARR, encaissements du mois, échecs de paiement et solde Stripe.</p>
          <Link href="/admin/revenue" className="btn btn-sm mt-2">
            Tableau de bord
          </Link>
        </div>
      </div>
    </div>
  );
}

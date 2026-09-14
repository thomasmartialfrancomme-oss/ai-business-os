import Link from "next/link";
import { requireOwner } from "@/lib/auth";
import { env } from "@/lib/env";
import { getBankDetails } from "@/lib/payments/bank-transfer";
import { getWebhookSecret } from "@/lib/payments";
import { Alert, Badge, SectionTitle } from "@/components/ui";
import { BankDetailsForm } from "@/components/BankDetailsForm";

export const dynamic = "force-dynamic";

/**
 * /admin/settings — configuration du propriétaire de la plateforme.
 *
 * Deux blocs de coordonnées, à ne pas confondre :
 *  1. les coordonnées de RÉCEPTION utilisées pour le virement bancaire des clients
 *     (stockées ici, modifiables par l'administrateur) ;
 *  2. le compte bancaire de VERSEMENT de vos fonds Stripe : il se configure
 *     exclusivement dans le tableau de bord Stripe (nous ne stockons aucun IBAN de
 *     versement, et nous ne créons aucun compte Stripe Connect pour vos clients).
 */
export default async function AdminSettingsPage() {
  const owner = await requireOwner("/admin/settings");
  const [bankDetails, webhookSecret] = await Promise.all([getBankDetails(), getWebhookSecret()]);

  return (
    <div className="container" style={{ paddingTop: 30 }}>
      <div className="row-between">
        <div>
          <h1>Paramètres de la plateforme</h1>
          <p className="muted">Propriétaire : {owner.email}</p>
        </div>
        <Link href="/admin/revenue" className="btn btn-sm btn-ghost">
          ← Revenus
        </Link>
      </div>

      <SectionTitle>Coordonnées bancaires affichées aux clients (virement)</SectionTitle>
      <div className="card">
        <p className="dim">
          Ces informations apparaissent sur les factures de virement émises pour vos clients professionnels. Un
          instantané est conservé sur chaque facture : modifier ces valeurs ne modifie pas les factures déjà émises.
        </p>
        <BankDetailsForm
          initial={{
            accountHolder: bankDetails.accountHolder,
            bankName: bankDetails.bankName,
            iban: bankDetails.iban,
            bic: bankDetails.bic,
            bankAddress: bankDetails.bankAddress,
            note: bankDetails.note,
          }}
          configured={bankDetails.configured}
        />
      </div>

      <SectionTitle>Compte Stripe & versements</SectionTitle>
      <div className="grid grid-2">
        <div className="card card-tight">
          <h3>Encaissez sur votre compte Stripe</h3>
          <p className="dim mt-2">
            Les paiements d'abonnement sont encaissés directement sur le compte Stripe que vous avez configuré. Le
            module ne crée aucun compte Stripe Connect pour vos clients : votre compte est le seul destinataire des
            fonds, et Stripe gère les versements vers le compte bancaire associé.
          </p>
          <dl className="kv mt-2">
            <dt>Mode actif</dt>
            <dd>
              <Badge tone={env.stripeMode === "live" ? "badge-success" : env.stripeMode === "test" ? "badge-info" : "badge-warning"}>
                {env.stripeMode === "simulation" ? "Simulation (aucune clé)" : `Stripe ${env.stripeMode.toUpperCase()}`}
              </Badge>
            </dd>
            <dt>Clé serveur</dt>
            <dd className="mono">{env.STRIPE_SECRET_KEY ? `${env.STRIPE_SECRET_KEY.slice(0, 8)}••••••••` : "non configurée"}</dd>
            <dt>Secret de webhook</dt>
            <dd className="mono">{webhookSecret ? `${webhookSecret.slice(0, 12)}••••••••` : "non configuré"}</dd>
            <dt>URL du webhook</dt>
            <dd className="mono">{`${env.APP_URL}/api/stripe/webhook`}</dd>
          </dl>
          <Alert tone="warning">
            Le compte bancaire de versement ne se configure pas ici : dans Stripe, ouvrez
            <strong> Paramètres → Virements → Compte bancaire</strong>. Stripe crédite automatiquement vos fonds selon la
            cadence choisie (quotidienne, hebdomadaire, manuelle).
          </Alert>
        </div>

        <div className="card card-tight">
          <h3>Liste de contrôle avant production</h3>
          <ol className="step-list mt-2">
            <li>Créer les produits et prix : <span className="mono">npm run stripe:setup</span> (rejoue en sécurité).</li>
            <li>Configurer l'endpoint webhook et copier le <span className="mono">whsec_…</span> dans <span className="mono">STRIPE_WEBHOOK_SECRET</span>.</li>
            <li>Événements à écouter : <span className="mono">checkout.session.completed</span>, <span className="mono">customer.subscription.*</span>, <span className="mono">invoice.paid</span>, <span className="mono">invoice.payment_failed</span>, <span className="mono">charge.refunded</span>.</li>
            <li>Activer le portail de facturation Stripe (moyens de paiement, factures, annulation).</li>
            <li>Renseigner le compte bancaire de versement dans Stripe et vérifier l'identité du compte (KYC).</li>
            <li>Passer en clé <span className="mono">sk_live_…</span> et refaire un parcours complet avec un vrai paiement de faible montant.</li>
          </ol>
          <Link href="/sim" className="btn btn-sm mt-2">
            Ouvrir le panneau de simulation (si activé)
          </Link>
        </div>
      </div>
    </div>
  );
}

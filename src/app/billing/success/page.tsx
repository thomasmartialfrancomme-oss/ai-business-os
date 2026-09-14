import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { Alert } from "@/components/ui";
import { SuccessPoller } from "@/components/SuccessPoller";

export const dynamic = "force-dynamic";

/**
 * /billing/success — retour depuis Stripe Checkout.
 *
 * ⚠️ Cette page N'ACTIVE AUCUN abonnement. Elle affiche l'état réel, écrit par le
 * webhook Stripe. Si l'utilisateur arrive ici sans que le webhook soit traité,
 * rien n'est accordé : c'est exactement le comportement exigé.
 */
export default async function CheckoutSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  const params = await searchParams;
  await requireUser("/billing/success");

  return (
    <div className="container-narrow" style={{ paddingTop: 44 }}>
      <h1>Merci !</h1>
      <p className="muted">
        Votre paiement a été soumis à Stripe. L'activation de l'abonnement dépend de la confirmation signée envoyée par
        Stripe à notre serveur.
      </p>

      <div className="mt-4">
        <SuccessPoller sessionId={params.session_id ?? null} />
      </div>

      <div className="mt-6">
        <Alert tone="info" title="Pourquoi cette attente ?">
          Le retour du navigateur n'est pas une preuve de paiement : il peut être simulé ou rejoué. Seul l'événement
          <span className="mono"> checkout.session.completed</span> signé par Stripe, vérifié par notre backend, permet
          d'activer l'abonnement.
        </Alert>
      </div>

      <p className="dim mt-4">
        Un problème ? <Link href="/billing">Ouvrez votre espace facturation</Link> ou utilisez « Synchroniser l'état ».
      </p>
    </div>
  );
}

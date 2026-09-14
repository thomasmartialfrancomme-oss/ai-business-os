import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { Alert } from "@/components/ui";
import { LoginForm } from "@/components/LoginForm";

export const dynamic = "force-dynamic";

/**
 * Connexion de démonstration : permet de changer d'identité (client / propriétaire)
 * pour tester le module. À remplacer par votre fournisseur d'identité en production.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const params = await searchParams;

  if (!env.demoLoginEnabled) {
    return (
      <div className="container-narrow" style={{ paddingTop: 40 }}>
        <h1>Connexion</h1>
        <Alert tone="warning" title="Authentification non configurée">
          La connexion de démonstration est désactivée sur cet environnement (comportement par défaut en production).
          Branchez votre fournisseur d'identité dans <span className="mono">src/lib/auth.ts</span> pour permettre la
          connexion des clients. Pour une démonstration privée, vous pouvez la réactiver avec la variable
          d'environnement <span className="mono">DEMO_LOGIN=true</span>.
        </Alert>
        <p className="dim mt-4">
          En attendant, les pages publiques restent consultables : <a href="/">accueil</a> et{" "}
          <a href="/pricing">tarifs</a>.
        </p>
      </div>
    );
  }

  const users = await prisma.user.findMany({
    select: { id: true, email: true, name: true, role: true, subscription: { select: { planCode: true, status: true } } },
    orderBy: [{ role: "desc" }, { createdAt: "asc" }],
  });

  return (
    <div className="container-narrow" style={{ paddingTop: 40 }}>
      <h1>Connexion</h1>
      <p className="muted">
        Sélectionnez une identité de démonstration. En production, cette page est remplacée par votre
        fournisseur d'identité (NextAuth, Clerk, SSO…) : les contrôles d'accès du module paiement
        (<span className="mono">requireUser</span>, <span className="mono">requireOwner</span>) restent inchangés.
      </p>

      {env.stripeMode === "simulation" && (
        <div className="mt-4">
          <Alert tone="info" title="Mode simulation actif">
            Aucune clé Stripe n'est configurée : les paiements sont simulés localement, avec de vrais webhooks signés.
            Ajoutez <span className="mono">STRIPE_SECRET_KEY=sk_test_…</span> pour basculer sur Stripe TEST.
          </Alert>
        </div>
      )}

      <div className="card mt-4">
        <LoginForm
          users={users.map((user) => ({
            id: user.id,
            email: user.email,
            name: user.name,
            role: user.role,
            plan: user.subscription?.planCode ?? null,
            status: user.subscription?.status ?? null,
          }))}
          next={params.next ?? null}
        />
      </div>
    </div>
  );
}

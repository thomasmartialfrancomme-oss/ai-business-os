import Link from "next/link";
import { getSessionUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { LogoutButton } from "./LogoutButton";

/** Barre de navigation (composant serveur : la session provient du cookie signé). */
export async function Nav() {
  const user = await getSessionUser();

  return (
    <header className="nav">
      <div className="container nav-inner">
        <Link href="/" className="brand">
          <span className="brand-mark">AI</span>
          <span>AI Business OS</span>
        </Link>

        <nav className="nav-links">
          <Link href="/pricing" className="nav-link">
            Tarifs
          </Link>

          {user && (
            <Link href="/billing" className="nav-link">
              Facturation
            </Link>
          )}
          {user?.isOwner && (
            <Link href="/admin/revenue" className="nav-link">
              Revenus
            </Link>
          )}
          {user?.isOwner && (
            <Link href="/admin/settings" className="nav-link">
              Paramètres
            </Link>
          )}
          {env.simulationAllowed && env.stripeMode === "simulation" && (
            <Link href="/sim" className="nav-link">
              Simulation
            </Link>
          )}

          {env.simulationAllowed && env.stripeMode === "simulation" ? (
            <span className="badge badge-warning" title="Aucune clé Stripe configurée : les paiements sont simulés.">
              Mode simulation
            </span>
          ) : (
            <span className={`badge ${env.stripeMode === "live" ? "badge-success" : "badge-info"}`}>
              Stripe {env.stripeMode === "live" ? "LIVE" : "TEST"}
            </span>
          )}

          {user ? (
            <span className="row" style={{ gap: 10 }}>
              <span className="dim nowrap" title={user.email}>
                {user.name}
                {user.isOwner ? " (propriétaire)" : ""}
              </span>
              <LogoutButton />
            </span>
          ) : (
            <Link href="/login" className="btn btn-sm btn-primary">
              Se connecter
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}

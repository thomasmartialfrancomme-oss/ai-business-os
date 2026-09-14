import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "@/components/Nav";

export const metadata: Metadata = {
  title: "AI Business OS — Paiement & abonnements",
  description:
    "Module de paiement Stripe d'AI Business OS : abonnements, webhooks vérifiés, facturation, revenus et virements bancaires.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <Nav />
        <main style={{ paddingBottom: 40 }}>{children}</main>
        <footer className="footer">
          <div className="container row-between">
            <span>
              AI Business OS — module paiement. Les cartes sont traitées par Stripe : aucune donnée de carte n'est
              stockée par l'application.
            </span>
            <span className="mono">/api/stripe/webhook</span>
          </div>
        </footer>
      </body>
    </html>
  );
}

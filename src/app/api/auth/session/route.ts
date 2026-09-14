import { cookies } from "next/headers";
import { SESSION_COOKIE, createSessionToken, getSessionUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { prisma } from "@/lib/db";
import { assertSameOrigin, errorResponse, json } from "@/lib/http";

/**
 * Authentification de démonstration.
 *
 * ⚠️ À REMPLACER en production par votre fournisseur d'identité (NextAuth, Clerk,
 * Auth0, SSO…). Elle n'existe ici que pour permettre de tester le module paiement
 * avec un client et le propriétaire de la plateforme. Aucune donnée de paiement
 * ne dépend de cette couche : l'identité du client Stripe vient des webhooks.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET : session courante. */
export async function GET(): Promise<Response> {
  try {
    const user = await getSessionUser();
    // La liste des comptes n'est exposée que si la connexion de démonstration est active.
    const users = env.demoLoginEnabled
      ? await prisma.user.findMany({
          select: { id: true, email: true, name: true, role: true },
          orderBy: { createdAt: "asc" },
        })
      : [];
    return json({ user, users });
  } catch (error) {
    return errorResponse(error, "auth/session GET");
  }
}

/** POST : connexion (choix d'un utilisateur par e-mail) — démo. */
export async function POST(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);

    // ⚠️ GARDE-FOU DE PRODUCTION : sans fournisseur d'identité branché, la connexion
    // de démonstration permettrait à n'importe qui de se connecter en tant que
    // propriétaire. Elle est donc désactivée par défaut en production.
    if (!env.demoLoginEnabled) {
      return json(
        {
          error: "auth_not_configured",
          message:
            "Authentification non configurée : remplacez la connexion de démonstration (src/lib/auth.ts) par votre fournisseur d'identité, ou définissez DEMO_LOGIN=true pour une démonstration privée.",
        },
        403
      );
    }

    const body = (await request.json().catch(() => ({}))) as { email?: string; userId?: string };

    const user = body.userId
      ? await prisma.user.findUnique({ where: { id: body.userId } })
      : body.email
        ? await prisma.user.findUnique({ where: { email: body.email } })
        : null;

    if (!user) return json({ error: "user_not_found", message: "Utilisateur inconnu." }, 404);

    const store = await cookies();
    store.set(SESSION_COOKIE, createSessionToken(user.id), {
      httpOnly: true,
      sameSite: "lax",
      secure: env.isProduction,
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });

    return json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      redirectTo: user.role === "OWNER" ? "/admin/revenue" : "/billing",
    });
  } catch (error) {
    return errorResponse(error, "auth/session POST");
  }
}

/** DELETE : déconnexion. */
export async function DELETE(request: Request): Promise<Response> {
  try {
    assertSameOrigin(request);
    const store = await cookies();
    store.delete(SESSION_COOKIE);
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error, "auth/session DELETE");
  }
}

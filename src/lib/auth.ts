import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "./db";
import { env } from "./env";

/**
 * Authentification de démonstration (cookie signé HMAC).
 *
 * ⚠️ Cette couche existe uniquement pour rendre le module paiement testable de bout en bout
 * (un client et le propriétaire de la plateforme). En production, remplacez-la par votre
 * fournisseur d'identité réel (NextAuth, Clerk, Auth0, SSO…) : les règles d'autorisation
 * ci-dessous (`requireOwner`, contrôle d'accès dans /admin) restent valables telles quelles.
 */

export const SESSION_COOKIE = "aibos_session";

function sign(value: string): string {
  return createHmac("sha256", env.APP_SECRET).update(value).digest("base64url");
}

export function createSessionToken(userId: string): string {
  return `${userId}.${sign(userId)}`;
}

export function verifySessionToken(token: string | undefined): string | null {
  if (!token) return null;
  const index = token.lastIndexOf(".");
  if (index <= 0) return null;
  const userId = token.slice(0, index);
  const signature = token.slice(index + 1);
  const expected = sign(userId);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return userId;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: "CUSTOMER" | "OWNER";
  isOwner: boolean;
}

/** Utilisateur courant (ou null). Ne renvoie jamais un utilisateur supprimé/inconnu. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const userId = verifySessionToken(store.get(SESSION_COOKIE)?.value);
  if (!userId) return null;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    isOwner: user.role === "OWNER",
  };
}

/** Utilisateur connecté obligatoire (redirige vers /login sinon). */
export async function requireUser(returnTo = "/billing"): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  return user;
}

/**
 * Variante API de `requireOwner`.
 *
 * ⚠️ Dans une route API, on ne redirige pas : on renvoie un code explicite
 * (401 non authentifié / 403 non autorisé) pour que le client sache exactement
 * pourquoi l'action est refusée. Les pages, elles, utilisent `requireOwner`.
 */
export async function getOwnerForApi(): Promise<
  { ok: true; user: SessionUser } | { ok: false; status: 401 | 403; error: string; message: string }
> {
  const user = await getSessionUser();
  if (!user) {
    return { ok: false, status: 401, error: "unauthenticated", message: "Connexion requise." };
  }
  if (!user.isOwner) {
    return {
      ok: false,
      status: 403,
      error: "forbidden",
      message: "Action réservée au propriétaire de la plateforme.",
    };
  }
  return { ok: true, user };
}

/** Propriétaire de la plateforme obligatoire (sinon redirection — usage page). */
export async function requireOwner(returnTo = "/admin/revenue"): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(returnTo)}`);
  if (!user.isOwner) redirect("/billing?error=forbidden");
  return user;
}

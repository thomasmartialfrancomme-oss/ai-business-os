import { NextResponse } from "next/server";
import { BillingError } from "./payments/service";

/**
 * Utilitaires HTTP partagés par les routes API.
 */

/** Réponse JSON homogène. */
export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body as Record<string, unknown>, { status });
}

/** Origine publique de l'application, déduite de la requête (proxy, preview, production). */
export function getOrigin(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const host = forwardedHost ?? request.headers.get("host");
  if (host) return `${forwardedProto ?? "http"}://${host}`;
  return new URL(request.url).origin;
}

/**
 * Protection CSRF : toute action modifiant l'état doit venir de notre propre origine.
 * Les cookies de session sont de toute façon en SameSite=Lax, mais ce contrôle ferme
 * la porte aux requêtes cross-site forgées.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return; // requêtes serveur/curl sans Origin : autorisées (pas de cookie ambiant)
  const allowed = new Set([getOrigin(request)]);
  const configured = process.env.APP_URL;
  if (configured) allowed.add(configured.replace(/\/$/, ""));
  if (!allowed.has(origin)) {
    throw new BillingError("Origine non autorisée pour cette action.", "csrf_origin_invalid", 403);
  }
}

/** Limiteur de débit en mémoire (par utilisateur + action). Suffisant pour une instance. */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit = 20, windowMs = 60_000): void {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    throw new BillingError("Trop de tentatives. Merci de patienter quelques instants.", "rate_limited", 429);
  }
}

/** Conversion homogène des erreurs en réponses JSON (jamais de fuite de stack). */
export function errorResponse(error: unknown, context: string): NextResponse {
  if (error instanceof BillingError) {
    return json({ error: error.code, message: error.message }, error.status);
  }
  console.error(`[api] ${context}`, error);
  return json({ error: "internal_error", message: "Une erreur interne est survenue." }, 500);
}

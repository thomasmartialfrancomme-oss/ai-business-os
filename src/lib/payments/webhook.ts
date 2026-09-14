import Stripe from "stripe";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { env } from "../env";
import { writeAudit } from "../audit";
import { getGateway, getWebhookSecret } from ".";
import { applyEvent } from "./state";
import type { StripeEvent } from "./types";

/**
 * Traitement d'un webhook Stripe : vérification de signature, idempotence, application.
 *
 * Cette fonction est appelée :
 *   1. par la route POST /api/stripe/webhook (réception réelle depuis Stripe) ;
 *   2. par le livreur d'événements du mode simulation, ce qui garantit que la
 *      démonstration emprunte EXACTEMENT le même chemin de code et les mêmes
 *      contrôles de sécurité que la production.
 */

/** Tolérance sur l'horodatage de signature (protection contre le rejeu d'un vieux webhook). */
const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

export async function processWebhook(rawBody: string, signatureHeader: string | null): Promise<WebhookResult> {
  // ── 1. Signature obligatoire ────────────────────────────────────────────────
  if (!signatureHeader) {
    await writeAudit({
      actorType: "SYSTEM",
      action: "webhook.signature_missing",
      targetType: "webhook",
      metadata: { reason: "en-tête stripe-signature absent" },
    });
    return { status: 400, body: { error: "signature_missing", message: "En-tête Stripe-Signature absent." } };
  }

  const secret = await getWebhookSecret();
  if (!secret) {
    return {
      status: 500,
      body: {
        error: "webhook_secret_missing",
        message: "Aucun secret de webhook configuré (STRIPE_WEBHOOK_SECRET). Aucun événement ne peut être validé.",
      },
    };
  }

  // ── 2. Vérification cryptographique par le SDK officiel Stripe ───────────────
  // On n'implémente JAMAIS la vérification à la main : c'est constructEvent qui
  // recalcule le HMAC-SHA256 et contrôle la fenêtre temporelle.
  let event: StripeEvent<Record<string, unknown>>;
  try {
    const verified = Stripe.webhooks.constructEvent(rawBody, signatureHeader, secret, SIGNATURE_TOLERANCE_SECONDS);
    event = verified as unknown as StripeEvent<Record<string, unknown>>;
  } catch (error) {
    const message = error instanceof Error ? error.message : "signature invalide";
    await writeAudit({
      actorType: "SYSTEM",
      action: "webhook.signature_invalid",
      targetType: "webhook",
      metadata: { reason: message },
    });
    // 400 : Stripe ne réessaiera pas (une signature invalide ne se « répare » pas),
    // et aucune donnée n'est écrite en base.
    return { status: 400, body: { error: "invalid_signature", message } };
  }

  // ── 3. Cohérence environnement (test/live vs simulation) ─────────────────────
  // Un événement du mode live ne doit jamais pouvoir être traité par un environnement
  // de test (et inversement) : sinon un encaissement réel écrirait dans la base de test.
  const expectedLivemode = env.stripeMode === "live";
  if (Boolean(event.livemode) !== expectedLivemode) {
    await writeAudit({
      actorType: "SYSTEM",
      action: "webhook.mode_mismatch",
      targetType: "webhook",
      metadata: { eventId: event.id, livemode: Boolean(event.livemode), mode: env.stripeMode },
    });
    return {
      status: 400,
      body: { error: "mode_mismatch", message: "Événement d'un autre environnement (test/live)." },
    };
  }

  // ── 4. Idempotence : un webhook répété n'est jamais rejoué ───────────────────
  try {
    await prisma.webhookEvent.create({
      data: {
        stripeEventId: event.id,
        type: event.type,
        apiVersion: event.api_version ?? null,
        livemode: Boolean(event.livemode),
        payload: event as unknown as Prisma.InputJsonValue,
        status: "PROCESSED",
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const existing = await prisma.webhookEvent.findUnique({ where: { stripeEventId: event.id } });
      await writeAudit({
        actorType: "SYSTEM",
        action: "webhook.duplicate_ignored",
        targetType: "webhook",
        targetId: event.id,
        metadata: { type: event.type, firstStatus: existing?.status ?? null },
      });
      return {
        status: 200,
        body: { received: true, duplicate: true, eventId: event.id, message: "Événement déjà traité — ignoré." },
      };
    }
    throw error;
  }

  // ── 5. Application de l'événement (seule écriture d'état autorisée) ──────────
  try {
    const gateway = getGateway();
    const result = await applyEvent(event, {
      // Relecture à la source quand l'événement ne porte pas tout l'état (checkout terminé).
      retrieveSubscription: (id) => gateway.retrieveSubscription(id),
    });

    await prisma.webhookEvent.update({
      where: { stripeEventId: event.id },
      data: {
        status: result.handled ? "PROCESSED" : "IGNORED",
        processedAt: new Date(),
      },
    });

    return {
      status: 200,
      body: { received: true, eventId: event.id, type: event.type, handled: result.handled, note: result.note },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.webhookEvent.update({
      where: { stripeEventId: event.id },
      data: { status: "FAILED", error: message, processedAt: new Date() },
    });
    await writeAudit({
      actorType: "SYSTEM",
      action: "webhook.processing_failed",
      targetType: "webhook",
      targetId: event.id,
      metadata: { type: event.type, error: message },
    });

    // 500 : Stripe réessaiera avec un back-off exponentiel pendant plusieurs jours.
    return { status: 500, body: { error: "processing_failed", eventId: event.id, message } };
  }
}

/** Statut de santé du traitement des webhooks (affiché dans /admin/revenue). */
export async function webhookHealth() {
  const [total, failed, duplicates, last] = await Promise.all([
    prisma.webhookEvent.count(),
    prisma.webhookEvent.count({ where: { status: "FAILED" } }),
    prisma.webhookEvent.count({ where: { status: "IGNORED" } }),
    prisma.webhookEvent.findFirst({ orderBy: { receivedAt: "desc" } }),
  ]);
  return { total, failed, duplicates, lastReceivedAt: last?.receivedAt ?? null, lastType: last?.type ?? null };
}

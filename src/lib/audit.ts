import type { ActorType, Prisma } from "@prisma/client";
import { prisma } from "./db";

/**
 * Piste d'audit. Toute écriture d'état liée au paiement DOIT passer par un appel
 * tracé ici : on peut ainsi répondre à « pourquoi cet abonnement est-il actif ? ».
 */
export async function writeAudit(input: {
  actorType: ActorType;
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  userId?: string | null;
  metadata?: Prisma.InputJsonValue;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        userId: input.userId ?? null,
        metadata: input.metadata ?? undefined,
      },
    });
  } catch (error) {
    // Un échec d'audit ne doit jamais empêcher le traitement d'un webhook Stripe
    // (Stripe rejouerait l'événement). On journalise sur stderr.
    console.error("[audit] échec d'écriture", input.action, error);
  }
}

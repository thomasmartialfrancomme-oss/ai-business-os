import { PrismaClient } from "@prisma/client";

/**
 * Client Prisma partagé (serveur uniquement).
 * Le singleton évite d'épuiser le pool de connexions pendant le hot-reload de Next.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === "query" ? ["query", "warn", "error"] : ["warn", "error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

if (typeof window !== "undefined") {
  throw new Error("src/lib/db.ts ne doit jamais être importé côté navigateur (accès base de données).");
}

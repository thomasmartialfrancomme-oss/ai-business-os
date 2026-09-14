/**
 * scripts/run-tests.ts — lanceur de la suite de validation.
 *
 * 1. Synchronise le schéma Prisma sur la base de TEST (DATABASE_URL_TEST).
 * 2. Exécute les tests (scénarios de paiement, sécurité, unitaires).
 * 3. Affiche un récapitulatif.
 *
 * Utilisation : npm test
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

// Charge .env sans dépendance externe (dotenv est disponible via Prisma, mais restons autonomes).
function loadEnv(): Record<string, string> {
  const path = join(ROOT, ".env");
  if (!existsSync(path)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/.exec(line);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

const env = { ...loadEnv(), ...process.env };
const testDatabaseUrl = env.DATABASE_URL_TEST ?? env.DATABASE_URL;

if (!testDatabaseUrl) {
  console.error("✗ DATABASE_URL_TEST ou DATABASE_URL doit être défini dans .env");
  process.exit(1);
}

console.log("══ Préparation de la base de test ══");
console.log(`Base : ${testDatabaseUrl.replace(/:[^:@/]*@/, ":***@")}`);

try {
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
    cwd: ROOT,
    env: { ...env, DATABASE_URL: testDatabaseUrl },
    stdio: "inherit",
  });
} catch {
  console.error("✗ Impossible de synchroniser le schéma sur la base de test (PostgreSQL est-il démarré ?).");
  process.exit(1);
}

console.log("\n══ Exécution des tests (séquentiel : les tests partagent la même base) ══\n");

const files = ["tests/scenarios.test.ts", "tests/security.test.ts", "tests/unit/pricing.test.ts", "tests/unit/access.test.ts"];

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "--test-concurrency=1", "--test-reporter=spec", ...files],
  {
    cwd: ROOT,
    env: { ...env, DATABASE_URL: testDatabaseUrl, DATABASE_URL_TEST: testDatabaseUrl, NODE_ENV: "test", ALLOW_SIMULATION: "true" },
    stdio: "inherit",
  }
);

console.log("\n══ Récapitulatif ══");
if (result.status === 0) {
  console.log("✓ Tous les tests sont passés : parcours de paiement, sécurité et unitaires.");
  console.log("  Scénarios couverts : paiement réussi, refusé, abonnement créé, renouvelé, échoué,");
  console.log("  annulation, changement de forfait, remboursement, webhook invalide, webhook répété,");
  console.log("  virement bancaire (déclaration + confirmation administrative), événement hors ordre.");
} else {
  console.log("✗ Des tests ont échoué. Corrigez avant de préparer la production.");
}

process.exit(result.status ?? 1);

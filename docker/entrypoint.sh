#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════════
#  Point d'entrée du conteneur : prépare la base puis démarre l'application.
#
#  Variables reconnues :
#    DATABASE_URL      (obligatoire) chaîne de connexion PostgreSQL
#    RUN_MIGRATIONS    "true" (défaut) applique le schéma avant démarrage
#    SEED_DEMO         "true" charge les données de démonstration si la base est vide
#    SEED_FORCE        "true" recharge les données de démonstration même si des comptes existent
# ═══════════════════════════════════════════════════════════════════════════════
set -e

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[entrypoint] ✗ DATABASE_URL n'est pas défini." >&2
  exit 1
fi

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] → Synchronisation du schéma de base…"
  # En production, remplacez par : npx prisma migrate deploy (après avoir versionné
  # vos migrations avec « npx prisma migrate dev --name init »).
  npx prisma db push --skip-generate --accept-data-loss

  # Le peuplement de démonstration ne s'exécute QUE sur une base vide : sans cette
  # garde, chaque redéploiement effacerait les abonnements réels (le seed remet tout à zéro).
  COMPTES=$(npx prisma db execute --stdin <<'SQL' 2>/dev/null | tr -dc '0-9' || echo 0
SELECT count(*) FROM users;
SQL
)
  if [ "${SEED_FORCE:-false}" = "true" ]; then
    echo "[entrypoint] → Réinitialisation forcée des données de démonstration…"
    npx tsx prisma/seed.ts || echo "[entrypoint] ⚠️ peuplement ignoré"
  elif [ "${SEED_DEMO:-false}" = "true" ] && [ "${COMPTES:-0}" = "0" ]; then
    echo "[entrypoint] → Base vide : chargement des données de démonstration…"
    npx tsx prisma/seed.ts || echo "[entrypoint] ⚠️ peuplement ignoré"
  elif [ "${SEED_DEMO:-false}" = "true" ]; then
    echo "[entrypoint] → Base déjà peuplée (${COMPTES} comptes) : peuplement ignoré"
  fi
fi

if [ -n "${APP_URL:-}" ]; then
  echo "[entrypoint] URL publique : ${APP_URL}"
  echo "[entrypoint] Endpoint webhook Stripe : ${APP_URL%/}/api/stripe/webhook"
fi

echo "[entrypoint] → Démarrage de l'application (port ${PORT:-3000})"
exec "$@"

#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  Démarrage complet du module paiement en une commande.
#
#  Usage :  bash scripts/start-local.sh [--dev] [--port 3000]
#
#  Ce script :
#    1. vérifie/répare les répertoires de PostgreSQL (ils peuvent disparaître
#       lors d'une mise en veille du bac à sable : ce sont des dossiers vides) ;
#    2. démarre PostgreSQL s'il n'écoute pas déjà ;
#    3. crée la base et synchronise le schéma Prisma si nécessaire ;
#    4. charge les données de démonstration si la base est vide ;
#    5. compile (si besoin) puis démarre l'application sur 0.0.0.0.
# ═══════════════════════════════════════════════════════════════════════════════
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PGDATA="${PGDATA:-$HOME/.pgdata}"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/17/bin}"
PGPORT="${PGPORT:-5432}"
PORT="${PORT:-3000}"
MODE="start"

while [ $# -gt 0 ]; do
  case "$1" in
    --dev) MODE="dev"; shift ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "Option inconnue : $1"; exit 1 ;;
  esac
done

log() { printf '%s\n' "$*"; }

# ── 0. Configuration locale ───────────────────────────────────────────────────
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    # Base locale sans mot de passe + secrets de développement générés
    python3 - <<'PYEOF'
import pathlib, secrets
p = pathlib.Path(".env")
s = p.read_text()
s = s.replace('DATABASE_URL="postgresql://user:password@localhost:5432/aibos?schema=public"',
              'DATABASE_URL="postgresql://postgres@127.0.0.1:5432/aibos?schema=public"')
s = s.replace('APP_SECRET="changez-moi-par-32-caracteres-aleatoires-minimum"',
              f'APP_SECRET="{secrets.token_hex(24)}"')
s += '\n# Démonstration : connexion sans mot de passe (à passer à "false" avec un vrai site)\nDEMO_LOGIN="true"\n'
p.write_text(s)
PYEOF
    log "✓ .env créé automatiquement depuis .env.example (secret aléatoire généré)"
  else
    log "✗ .env absent et .env.example introuvable"; exit 1
  fi
fi

# ── 1. Répertoires PostgreSQL ─────────────────────────────────────────────────
if [ -d "$PGDATA" ]; then
  for dir in pg_notify pg_tblspc pg_twophase pg_commit_ts pg_dynshmem pg_replslot \
             pg_serial pg_snapshots pg_stat pg_stat_tmp pg_wal/summaries \
             pg_wal/archive_status pg_logical/snapshots pg_logical/mappings \
             pg_multixact/members pg_multixact/offsets; do
    mkdir -p "$PGDATA/$dir"
  done
  rm -f "$PGDATA/postmaster.pid"
  chmod 700 "$PGDATA" 2>/dev/null || true
fi

# ── 2. Démarrage de PostgreSQL ────────────────────────────────────────────────
if ss -ltn 2>/dev/null | grep -q ":$PGPORT "; then
  log "✓ PostgreSQL écoute déjà sur le port $PGPORT"
elif [ -x "$PG_BIN/postgres" ] && [ -f "$PGDATA/PG_VERSION" ]; then
  log "→ Démarrage de PostgreSQL ($PGDATA)…"
  nohup "$PG_BIN/postgres" -D "$PGDATA" -p "$PGPORT" -k /tmp -c listen_addresses=127.0.0.1 \
    > /tmp/postgres.log 2>&1 &
  for _ in $(seq 1 20); do
    ss -ltn 2>/dev/null | grep -q ":$PGPORT " && break
    sleep 0.5
  done
  ss -ltn 2>/dev/null | grep -q ":$PGPORT " \
    && log "✓ PostgreSQL démarré" \
    || { log "✗ PostgreSQL n'a pas démarré — voir /tmp/postgres.log"; tail -5 /tmp/postgres.log; exit 1; }
else
  log "✗ PostgreSQL introuvable. Installez-le : sudo apt-get install -y postgresql"
  exit 1
fi

# ── 3. Base de données + schéma ───────────────────────────────────────────────
DB_NAME="${DB_NAME:-aibos}"
"$PG_BIN/psql" -h 127.0.0.1 -p "$PGPORT" -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" 2>/dev/null | grep -q 1 \
  || "$PG_BIN/psql" -h 127.0.0.1 -p "$PGPORT" -U postgres -c "CREATE DATABASE $DB_NAME" >/dev/null 2>&1

TABLES=$("$PG_BIN/psql" -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB_NAME" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo 0)
if [ "${TABLES:-0}" -lt 5 ]; then
  log "→ Synchronisation du schéma Prisma…"
  npx prisma db push --skip-generate --accept-data-loss >/dev/null 2>&1 && log "✓ Schéma créé"
fi

USERS=$("$PG_BIN/psql" -h 127.0.0.1 -p "$PGPORT" -U postgres -d "$DB_NAME" -tAc "SELECT count(*) FROM users" 2>/dev/null || echo 0)
if [ "${USERS:-0}" -eq 0 ]; then
  log "→ Chargement des données de démonstration…"
  npx tsx prisma/seed.ts >/dev/null 2>&1 && log "✓ Données créées (propriétaire + 6 clients)"
fi

# ── 4. Démarrage de l'application ─────────────────────────────────────────────
if [ "$MODE" = "dev" ]; then
  log "→ Application en mode développement : http://localhost:$PORT"
  exec npx next dev -H 0.0.0.0 -p "$PORT"
fi

if [ ! -f .next/BUILD_ID ]; then
  log "→ Compilation de l'application…"
  npx next build > /tmp/next-build.log 2>&1 && log "✓ Compilation terminée" \
    || { log "✗ Échec de compilation — voir /tmp/next-build.log"; exit 1; }
fi

log "→ Application : http://localhost:$PORT  (ou le panneau Aperçu de l'interface)"
log "  Comptes : emma@exemple.fr (client), owner@ai-business-os.test (propriétaire) — via /login"
exec npx next start -H 0.0.0.0 -p "$PORT"

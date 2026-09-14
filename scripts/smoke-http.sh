#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
#  Test de fumée HTTP — vérifie les points critiques sur un serveur en marche.
#  Usage : bash scripts/smoke-http.sh [base_url]
#
#  Couvre : pages publiques, endpoint webhook (signature absente/invalide),
#           parcours complet de souscription (checkout → paiement simulé →
#           webhooks signés → activation), lecture de l'espace facturation et
#           du tableau de bord propriétaire, règle « le frontend ne décide pas ».
# ═══════════════════════════════════════════════════════════════════════════════
set -uo pipefail
BASE="${1:-http://localhost:3000}"
JAR="$(mktemp)"
PASS=0
FAIL=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    printf '  ✓ %-58s %s\n' "$label" "$actual"
    PASS=$((PASS + 1))
  else
    printf '  ✗ %-58s attendu %s, obtenu %s\n' "$label" "$expected" "$actual"
    FAIL=$((FAIL + 1))
  fi
}

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "══ Tests HTTP sur $BASE ══"

echo
echo "→ Pages publiques"
check "GET /" 200 "$(status "$BASE/")"
check "GET /pricing" 200 "$(status "$BASE/pricing")"
check "GET /login" 200 "$(status "$BASE/login")"
check "GET /sim" 200 "$(status "$BASE/sim")"
check "GET /api/stripe/webhook (sonde)" 200 "$(status "$BASE/api/stripe/webhook")"

echo
echo "→ Webhook : refus de tout ce qui n'est pas signé par Stripe"
check "POST sans en-tête de signature" 400 "$(status -X POST -H 'content-type: application/json' -d '{"id":"evt_forge"}' "$BASE/api/stripe/webhook")"
check "POST avec signature falsifiée" 400 "$(status -X POST -H 'content-type: application/json' -H 'stripe-signature: t=1,v1=deadbeef' -d '{"id":"evt_forge2"}' "$BASE/api/stripe/webhook")"
check "POST avec corps non JSON signé" 400 "$(status -X POST -H 'content-type: application/json' -H 'stripe-signature: t=1,v1=deadbeef' -d 'pas-du-json' "$BASE/api/stripe/webhook")"

echo
echo "→ Accès protégés : aucun contenu sans session"
check "GET /billing sans session (redirection)" 307 "$(status "$BASE/billing")"
check "GET /admin/revenue sans session (redirection)" 307 "$(status "$BASE/admin/revenue")"
check "GET /api/billing/subscription/status sans session" 401 "$(status "$BASE/api/billing/subscription/status")"
check "POST /api/billing/checkout sans session" 401 "$(status -X POST -H 'content-type: application/json' -d '{"planCode":"PRO","interval":"MONTH"}' "$BASE/api/billing/checkout")"

echo
echo "→ Choix d'un compte de démonstration SANS abonnement actif"
# Le scénario de souscription exige un compte libre : on teste chaque candidat.
CLIENT_ID=""
CLIENT_EMAIL=""
for candidate in emma@exemple.fr farid@exemple.fr alice@exemple.fr; do
  CANDIDATE_ID=$(curl -s "$BASE/api/auth/session" | python3 -c "import sys,json;d=json.load(sys.stdin);print(next((u['id'] for u in d['users'] if u['email']=='$candidate'),''))")
  [ -z "$CANDIDATE_ID" ] && continue
  CJ="$(mktemp)"
  curl -s -o /dev/null -c "$CJ" -X POST -H 'content-type: application/json' -d "{\"userId\":\"$CANDIDATE_ID\"}" "$BASE/api/auth/session"
  CURRENT=$(curl -s -b "$CJ" "$BASE/api/billing/subscription/status" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status'))")
  rm -f "$CJ"
  if [ "$CURRENT" != "ACTIVE" ] && [ "$CURRENT" != "TRIALING" ]; then
    CLIENT_ID="$CANDIDATE_ID"; CLIENT_EMAIL="$candidate"; break
  fi
done

if [ -z "$CLIENT_ID" ]; then
  echo "  ! Aucun compte de démonstration libre (tous abonnés)."
  echo "    Lancez « npm run db:seed » pour repartir d'un état propre, puis relancez ce script."
  SKIPPED=1
else
  echo "  compte utilisé : $CLIENT_EMAIL"
  LOGIN=$(curl -s -c "$JAR" -X POST -H 'content-type: application/json' -d "{\"userId\":\"$CLIENT_ID\"}" "$BASE/api/auth/session")
  check "POST /api/auth/session" 200 "$(echo "$LOGIN" | python3 -c "import sys,json;print('200' if json.load(sys.stdin).get('user') else '0')")"
  check "GET /billing avec session" 200 "$(status -b "$JAR" "$BASE/billing")"

  echo
  echo "→ Parcours de souscription PRO 59 €/mois (mode simulation)"
  CHECKOUT=$(curl -s -b "$JAR" -c "$JAR" -X POST -H 'content-type: application/json' -H "origin: $BASE" -d '{"planCode":"PRO","interval":"MONTH"}' "$BASE/api/billing/checkout")
  SESSION_ID=$(echo "$CHECKOUT" | python3 -c "import sys,json;print(json.load(sys.stdin).get('sessionId',''))")
  AMOUNT=$(echo "$CHECKOUT" | python3 -c "import sys,json;print(json.load(sys.stdin).get('amountCents',0))")
  URL=$(echo "$CHECKOUT" | python3 -c "import sys,json;print(json.load(sys.stdin).get('url',''))")
  check "POST /api/billing/checkout crée une session" 200 "$([ -n "$SESSION_ID" ] && echo 200 || echo 0)"
  check "Montant calculé côté serveur (5900 c.)" 5900 "$AMOUNT"
  check "Redirection fournie" 200 "$([ -n "$URL" ] && echo 200 || echo 0)"

  echo "  · avant paiement, l'abonnement ne doit pas être actif :"
  STATUS_BEFORE=$(curl -s -b "$JAR" "$BASE/api/billing/subscription/status" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['status'],d['access']['allowed'])")
  check "statut avant paiement" "INCOMPLETE False" "$STATUS_BEFORE"

  echo "  · un client ne peut pas se déclarer payé :"
  check "POST forgé sur la route de statut (méthode non autorisée)" 405 "$(status -b "$JAR" -X POST "$BASE/api/billing/subscription/status")"

  echo "  · paiement (carte de test 4242) → webhooks signés → activation"
  PAY=$(curl -s -b "$JAR" -X POST -H 'content-type: application/json' -H "origin: $BASE" -d '{"outcome":"success","card":"4242424242424242"}' "$BASE/api/sim/checkout/$SESSION_ID/pay")
  DELIVERED=$(echo "$PAY" | python3 -c "import sys,json;d=json.load(sys.stdin);print(len([x for x in d.get('deliveries',[]) if x.get('status')==200]))")
  check "3 webhooks signés acceptés" 3 "$DELIVERED"
  check "Pages de retour accessibles" 200 "$(status -b "$JAR" "$BASE/billing/success?session_id=$SESSION_ID")"

  STATUS_AFTER=$(curl -s -b "$JAR" "$BASE/api/billing/subscription/status" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['status'],d['planCode'],d['access']['allowed'])")
  check "statut après paiement confirmé" "ACTIVE PRO True" "$STATUS_AFTER"

  echo
  echo "→ Idempotence : rejouer le paiement ne change rien"
  curl -s -o /dev/null -b "$JAR" -X POST -H 'content-type: application/json' -H "origin: $BASE" -d '{"outcome":"success"}' "$BASE/api/sim/checkout/$SESSION_ID/pay"
  STATUS_REPLAY=$(curl -s -b "$JAR" "$BASE/api/billing/subscription/status" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['status'],d['planCode'])")
  check "statut inchangé après rejeu" "ACTIVE PRO" "$STATUS_REPLAY"
fi

echo
echo "→ Espace propriétaire"
OWNER_ID=$(curl -s "$BASE/api/auth/session" | python3 -c "import sys,json;d=json.load(sys.stdin);print(next((u['id'] for u in d['users'] if u['role']=='OWNER'),''))")
if [ -n "$OWNER_ID" ]; then
  OWNER_JAR="$(mktemp)"
  curl -s -o /dev/null -c "$OWNER_JAR" -X POST -H 'content-type: application/json' -d "{\"userId\":\"$OWNER_ID\"}" "$BASE/api/auth/session"
  check "GET /admin/revenue (propriétaire)" 200 "$(status -b "$OWNER_JAR" "$BASE/admin/revenue")"
  check "GET /admin/settings (propriétaire)" 200 "$(status -b "$OWNER_JAR" "$BASE/admin/settings")"
  check "Un client ne peut pas consulter /admin/revenue" 307 "$(status -b "$JAR" "$BASE/admin/revenue")"
  check "Un client ne peut pas confirmer un virement" 403 "$(status -b "$JAR" -X POST -H 'content-type: application/json' -d '{"invoiceId":"x","reference":"AIB-X"}' "$BASE/api/admin/bank-transfer/confirm")"
  rm -f "$OWNER_JAR"
fi

rm -f "$JAR"
echo
echo "══ Résultat : $PASS réussis, $FAIL échoués ══"
[ "$FAIL" -eq 0 ] || exit 1

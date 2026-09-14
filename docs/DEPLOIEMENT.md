# Déploiement — obtenir une adresse permanente pour AI Business OS

L'aperçu du bac à sable est **temporaire** : il est lié à un environnement qui est recyclé, donc son lien
peut cesser de répondre. Ce document donne trois solutions pour obtenir une **adresse stable** que tu
peux partager avec des clients.

- **Option A — Docker en local** (5 minutes) : `http://localhost:3000` sur ta machine. Idéal pour tester.
- **Option B — VPS + Docker Compose** (le meilleur rapport contrôle/prix) : ton domaine, HTTPS, base incluse.
- **Option C — Plateforme gérée** (Railway / Render / Fly.io) : déploiement depuis un dépôt Git.

Dans les trois cas, la configuration Stripe (clés, prix, webhook) est la même — voir la section finale.

---

## Option A — Docker en local (le plus rapide)

```bash
# 1. Récupérer le projet (archive fournie ou dépôt Git)
unzip ai-business-os-module-paiement.zip && cd ai-business-os

# 2. Préparer la configuration
cp .env.production.template .env
#    Renseignez au minimum APP_SECRET (généré avec : openssl rand -hex 32)
#    Pour garder la démo utilisable en local : DEMO_LOGIN="true"

# 3. Démarrer base + application
docker compose up -d --build

# 4. Vérifier
docker compose ps
open http://localhost:3000        # macOS   (Linux : xdg-open, Windows : start)
```

Commandes utiles :

```bash
docker compose logs -f app        # journaux de l'application (webhooks inclus)
docker compose logs -f db         # journaux PostgreSQL
docker compose down               # arrêt (les données restent dans le volume dbdata)
docker compose down -v            # arrêt + suppression des données
```

Pour charger le jeu de démonstration : `SEED_DEMO=true docker compose up -d`.
Pour sortir du mode simulation : renseignez `STRIPE_SECRET_KEY=sk_test_…` puis
`docker compose up -d --build`.

---

## Option B — VPS + Docker Compose + HTTPS (recommandé pour la production)

Prérequis : un serveur (2 vCPU / 4 Go suffisent), un nom de domaine pointant vers son IP
(enregistrement `A` → `app.ton-domaine.com`).

```bash
# Sur le serveur (Debian/Ubuntu)
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git caddy

# Récupérer le projet (via dépôt Git ou scp de l'archive)
cd /opt && sudo git clone <ton-depot> ai-business-os && cd ai-business-os
sudo cp .env.production.template .env && sudo nano .env
```

Dans `.env`, pour un site réel :

```dotenv
DATABASE_URL="postgresql://aibos:MOT_DE_PASSE_FORT@db:5432/aibos?schema=public"
POSTGRES_PASSWORD="MOT_DE_PASSE_FORT"
APP_URL="https://app.ton-domaine.com"
APP_SECRET="…"                # openssl rand -hex 32
DEMO_LOGIN="false"            # ⚠️ obligatoire tant que l'authentification réelle n'est pas branchée
ALLOW_SIMULATION="false"
STRIPE_SECRET_KEY="sk_live_…"      # après la recette en mode test
STRIPE_WEBHOOK_SECRET="whsec_…"
STRIPE_PRICE_ID_STARTER_MONTH="price_…"   # créés par « npm run stripe:setup »
# … les 6 prix …
OWNER_EMAIL="ton-email@domaine.com"
```

Reverse proxy HTTPS automatique avec Caddy :

```bash
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
app.ton-domaine.com {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}
EOF

sudo systemctl reload caddy      # obtient automatiquement le certificat Let's Encrypt
cd /opt/ai-business-os && sudo docker compose up -d --build
```

Caddy gère les certificats et renouvellements. `APP_URL` doit exactement correspondre au domaine :
c'est l'URL que le module transmettra à Stripe pour les redirections et les webhooks.

---

## Option C — Plateforme gérée (Railway / Render / Fly.io)

Aucune administration de serveur, mais il faut un **dépôt Git** (GitHub) — l'archive ne suffit pas.

1. Poussez le projet sur GitHub (⚠️ `.env` exclu par `.gitignore`, vérifiez-le avant de pousser).
2. **Railway** : « New Project » → « Deploy from GitHub repo » ; ajoutez un service **PostgreSQL** ;
   Railway fournit `DATABASE_URL` automatiquement (ou recopiez-la dans les variables du service web).
   Ajoutez les autres variables (`APP_URL`, `APP_SECRET`, `DEMO_LOGIN=false`, `STRIPE_*`).
   Railway détecte le `Dockerfile` et l'expose avec HTTPS.
3. **Render** : « New Web Service » → dépôt → Runtime **Docker** → ajoutez un **PostgreSQL** managé →
   collez `DATABASE_URL` (chaîne interne) et les autres variables dans « Environment ».
4. **Fly.io** : `fly launch` (il détecte le `Dockerfile`), `fly postgres create`,
   `fly secrets set APP_SECRET=… STRIPE_SECRET_KEY=…`, puis `fly deploy`.

Dans tous les cas : renseignez `APP_URL` avec l'URL HTTPS fournie par la plateforme, puis reconfigurez
l'endpoint de webhook Stripe avec cette même URL.

---

## Configuration Stripe après déploiement

```bash
# Sur votre machine, avec le projet et les clés :
STRIPE_SECRET_KEY=sk_test_xxx APP_URL=https://app.ton-domaine.com npm run stripe:setup
# → crée les produits/prix, l'endpoint de webhook et le portail de facturation
# → affiche les STRIPE_PRICE_ID_* et le STRIPE_WEBHOOK_SECRET à mettre dans les variables du serveur

npm run stripe-verify-account     # contrôle : encaissement, virements, RIB, prix, webhook
```

Puis, dans le tableau de bord Stripe :

| À faire | Adresse |
|---|---|
| RIB de **versement** (ton argent) + cadence | `https://dashboard.stripe.com/settings/payouts` |
| Clés API (test puis live) | `https://dashboard.stripe.com/test/apikeys` |
| Endpoint de webhook | `https://dashboard.stripe.com/test/webhooks` |
| Vérification d'identité (KYC) | `https://dashboard.stripe.com/settings/account` |
| Facturation (raison sociale, TVA, logo) | `https://dashboard.stripe.com/settings/billing` |

L'endpoint à déclarer : `https://app.ton-domaine.com/api/stripe/webhook`, avec les événements listés
dans `docs/PRODUCTION.md`.

---

## Avant d'ouvrir au public : la liste minimale

| Point | Pourquoi |
|---|---|
| `DEMO_LOGIN="false"` + authentification réelle | Sinon n'importe qui peut se connecter en tant que propriétaire (la connexion de démonstration existe pour tester) |
| `ALLOW_SIMULATION="false"` | Coupe les routes `/api/sim/*` (404) et masque le panneau de simulation |
| `APP_SECRET` aléatoire de 32+ caractères | Signature des sessions |
| HTTPS | Obligatoire pour réceptionner les webhooks Stripe en confiance |
| `STRIPE_WEBHOOK_SECRET` de l'endpoint réel | Sans lui, aucun événement n'est accepté (par conception) |
| Sauvegardes de la base | `docker compose exec db pg_dump -U aibos aibos > sauvegarde.sql` |
| Alerte webhooks en échec | Stripe → Webhooks, ou supervision sur la table `webhook_events` |

Détail complet (recette de production, rollback, supervision) : `docs/PRODUCTION.md`.

---

## Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| Page blanche / 502 | Application non démarrée | `docker compose logs -f app` puis `docker compose restart app` |
| `Can't reach database server` | Base arrêtée ou `DATABASE_URL` erronée | `docker compose ps` ; vérifier le nom d'hôte (`db` dans Compose) |
| L'abonnement reste « en attente » | Webhook non reçu | Vérifier l'URL et le `whsec_…` dans Stripe → Webhooks → tentatives de livraison |
| `invalid_signature` dans les journaux | Mauvais `STRIPE_WEBHOOK_SECRET` (endpoint différent) | Recopier le secret de l'endpoint concerné |
| « Authentification non configurée » | `DEMO_LOGIN=false` en production | Normal : brancher votre fournisseur d'identité, ou `DEMO_LOGIN=true` pour une démo privée |
| Le formulaire de virement dit indisponible | Coordonnées de réception absentes | `/admin/settings` → renseigner IBAN + titulaire |
| Erreur `P1001` au démarrage | Base pas encore prête | Compose attend déjà la santé de la base ; relancer `docker compose up -d` |

---

## Rappel important sur l'aperçu du bac à sable

L'aperçu fourni par l'espace de travail est un **outil de démonstration temporaire** : il est rattaché à un
environnement jetable, son lien peut devenir invalide sans prévenir, et les processus s'arrêtent quand
l'environnement est recyclé. Pour une adresse qui reste en ligne — et *a fortiori* pour encaisser de vrais
paiements —, déployez avec l'une des options ci-dessus.

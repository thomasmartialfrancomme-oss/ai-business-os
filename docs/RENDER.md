# Mise en ligne sur Render — pas à pas

Objectif : obtenir une **adresse permanente** du type `https://ai-business-os.onrender.com`, en ligne
24 h/24, avec sa base PostgreSQL, en une vingtaine de minutes.

Deux chemins possibles, au choix :

- **Chemin A — Blueprint** (le plus rapide) : Render lit le fichier `render.yaml` du dépôt et crée
  automatiquement la base **et** le service web avec les bonnes variables.
- **Chemin B — création manuelle** : tu remplis les champs à la main (utile si le Blueprint refuse
  le dépôt privé). Les valeurs exactes sont données plus bas.

---

## Prérequis

1. Un compte Render : https://dashboard.render.com/register (inscription avec GitHub, c'est plus simple)
2. Ton dépôt GitHub : https://github.com/thomasmartialfrancomme-oss/ai-business-os (privé)
3. **Autoriser Render à lire ce dépôt** : lors de la première connexion, GitHub demande quels dépôts
   Render peut voir → choisis *Only select repositories* → coche `ai-business-os` → *Install*.
   Sans cette autorisation, le dépôt n'apparaît pas dans Render.

---

## Chemin A — Blueprint (recommandé)

1. Va sur **https://dashboard.render.com/blueprints**
2. Clique **New Blueprint Instance**
3. Sélectionne le dépôt `ai-business-os` → **Connect**
4. Render lit `render.yaml` et affiche ce qu'il va créer :
   - `ai-business-os-db` (PostgreSQL, plan Free, région Francfort)
   - `ai-business-os` (service web Docker, plan Free, région Francfort)
5. Il te demande de saisir les variables marquées « sync: false » (celles qui dépendent de toi) :
   - `APP_URL` → l'URL que Render va te donner, par exemple `https://ai-business-os.onrender.com`
     *(si tu ne la connais pas encore : laisse vide, tu la rempliras juste après le premier déploiement)*
   - `OWNER_EMAIL` → ton e-mail
   - Laisse **vides** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` et les `STRIPE_PRICE_ID_*` :
     le module démarre en mode simulation (aucun paiement réel, démonstration complète).
6. Clique **Apply** → le déploiement démarre (compte 5 à 10 minutes la première fois).

Passe ensuite à la section **Après le déploiement**.

---

## Chemin B — Création manuelle (si le Blueprint ne passe pas)

### B1. Créer la base de données

1. **https://dashboard.render.com/new/database**
2. Nom : `ai-business-os-db` — Database : `aibos` — User : `aibos`
3. Instance Type : **Free** (⚠️ expire au bout de 90 jours ; pour du durable, `Basic-256mb`)
4. Region : **Frankfurt (EU Central)** — le plus proche de La Réunion et de la zone euro
5. **Create Database** → attends l'état *Available*
6. Copie la ligne **Internal Database URL** (commence par `postgresql://…`) : elle sert à l'étape B3

### B2. Créer le service web

1. **https://dashboard.render.com/web/new** → **Build and deploy from a Git repository** → *Next*
2. Sélectionne le dépôt `ai-business-os`
3. Renseigne les champs :

| Champ | Valeur |
|---|---|
| **Name** | `ai-business-os` |
| **Region** | Frankfurt (EU Central) |
| **Branch** | `main` |
| **Language / Runtime** | **Docker** |
| **Dockerfile Path** | `./Dockerfile` |
| **Instance Type** | Free |
| **Health Check Path** | `/api/stripe/webhook` |
| **Auto-Deploy** | Yes (chaque push sur GitHub redéploie) |

4. Ne mets **rien** dans *Build Command* ni *Start Command* : le `Dockerfile` s'en occupe.

### B3. Variables d'environnement (section *Environment*)

| Clé | Valeur |
|---|---|
| `DATABASE_URL` | l'*Internal Database URL* copiée en B1 |
| `APP_SECRET` | clique sur **Generate** (Render crée une valeur aléatoire) |
| `APP_URL` | `https://ai-business-os.onrender.com` *(à ajuster avec l'URL réelle après le premier déploiement)* |
| `PORT` | *(à ne pas mettre)* — Render fournit lui-même 10000, et le `Dockerfile` l'utilise automatiquement |
| `DEMO_LOGIN` | `true` |
| `ALLOW_SIMULATION` | `auto` |
| `SEED_DEMO` | `true` |
| `ANNUAL_DISCOUNT_PERCENT` | `20` |
| `PAST_DUE_GRACE_DAYS` | `3` |
| `OWNER_EMAIL` | ton adresse e-mail |

> **Le port ?** Plus rien à faire : le `Dockerfile` du dépôt écoute sur le port que Render fournit
> (`PORT`, 10000 par défaut). Ne définis pas de variable `PORT` : laisse Render la fournir.

5. **Create Web Service** → le déploiement démarre.

---

## Après le déploiement (les vérifications)

### 1. Vérifier que le site répond

Ouvre l'URL affichée en haut de la page du service (ex. `https://ai-business-os.onrender.com`).
Tu dois voir la page d'accueil AI Business OS avec le badge **« Mode simulation »**.

### 2. Corriger `APP_URL` si besoin

Dans l'onglet **Environment** du service :

- mets `APP_URL` sur l'URL réelle du service (copie-la depuis le haut de la page) ;
- `SEED_DEMO` peut rester à `true` sans risque : le peuplement ne s'exécute **que si la base est
  vide**. Dès que la base contient des comptes, il est ignoré. Pour forcer un re-peuplement
  volontaire (efface tout), ajoute `SEED_FORCE=true` le temps d'un déploiement.
- clique **Save Changes** → Render redéploie.

### 3. Se connecter et tester le parcours

1. `https://<ton-url>/login` → connecte-toi en **Emma Tanaka** (cliente sans abonnement)
2. `/pricing` → **Pro — S'abonner (carte bancaire)** → carte `4242 4242 4242 4242`
3. `/billing/success` : la page attend la confirmation Stripe (elle n'active jamais rien elle-même)
4. `/billing` : abonnement actif, facture, historique
5. Reconnecte-toi en **Aurélie — Propriétaire** → `/admin/revenue` : revenus, MRR, ARR

---

## Brancher Stripe (quand tu voudras encaisser pour de vrai)

1. Récupère la clé de test : https://dashboard.stripe.com/test/apikeys
2. Sur **ta machine**, dans le projet : `npm run stripe:setup` (voir `docs/CHECKLIST-PROPRIETAIRE.md`)
3. Dans Render → **Environment**, ajoute `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` et les six
   `STRIPE_PRICE_ID_*`
4. Déclare l'endpoint de webhook dans Stripe :
   **https://dashboard.stripe.com/test/webhooks** → *Add endpoint* →
   `https://<ton-url>.onrender.com/api/stripe/webhook`
5. RIB de versement (ton argent) : **https://dashboard.stripe.com/settings/payouts**

---

## Points d'attention spécifiques à Render

| Point | À savoir |
|---|---|
| **Plan Free — mise en veille** | Un service web gratuit s'endort après 15 min sans visite ; le premier accès suivant prend environ une minute. Pour un service permanent : plan *Starter*. |
| **Plan Free — base** | La base PostgreSQL gratuite **expire au bout de 90 jours**. Pour du durable : `Basic-256mb`, ou une base externe gratuite (Neon, Supabase) dont tu colles l'URL dans `DATABASE_URL`. |
| **Variables modifiées** | Enregistrer une variable déclenche un redéploiement automatique. |
| **Journaux** | Onglet **Logs** du service : tu y vois les migrations, le peuplement et chaque webhook traité. |
| **Port** | Automatique : Render fournit `PORT` (10000 par défaut) et le `Dockerfile` écoute dessus. Aucune variable à créer. |
| **Pas de disque persistant** | Inutile ici : les données sont dans PostgreSQL, pas dans le conteneur. |

---

## En cas de problème

| Symptôme | Cause probable | Solution |
|---|---|---|
| « No open ports detected » | L'application écoute sur un port que Render n'attend pas | Ne définis **pas** de variable `PORT` (Render la fournit), et vérifie que le *Language* est bien **Docker** |
| Le déploiement échoue à la compilation | Configuration incomplète au build | C'est déjà traité : le `Dockerfile` du dépôt fournit des valeurs de substitution. Vérifie que le *Language* est bien **Docker**. |
| `Can't reach database server` | `DATABASE_URL` absente ou externe alors que le service est en plan gratuit | Utilise impérativement l'**Internal Database URL** |
| Le dépôt n'apparaît pas dans Render | Render n'est pas autorisé sur ce dépôt privé | GitHub → Settings → Applications → *Render* → autoriser le dépôt |
| Page d'accueil sans comptes de démonstration | `SEED_DEMO` à `false`, ou base non vide sans comptes | Mets `SEED_DEMO=true` pour peupler une base vide ; `SEED_FORCE=true` pour effacer et repeupler |
| « Authentification non configurée » sur /login | `DEMO_LOGIN` à `false` | Mets `DEMO_LOGIN=true` pour la démo (ou branche ton fournisseur d'identité) |

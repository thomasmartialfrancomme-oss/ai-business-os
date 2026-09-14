# Accès : jeton Git (GitHub) et clés Stripe

Tous les liens au même endroit, avec la marche à suivre exacte.

---

## 1. Jeton d'accès Git — pour pouvoir `git push`

GitHub n'accepte plus ton mot de passe pour pousser du code : il faut un **jeton d'accès
personnel** (PAT) ou une **clé SSH**.

### 1a. Lien direct pour créer le jeton

| Type | Lien | Quand l'utiliser |
|---|---|---|
| **Jeton fine-grained** (recommandé) | **https://github.com/settings/personal-access-tokens/new** | Nouveau projet : tu limites l'accès à un seul dépôt |
| Jeton « classique » | **https://github.com/settings/tokens** | Le plus simple : coche la case `repo` |
| Liste de tes jetons existants | https://github.com/settings/personal-access-tokens | Pour révoquer ou vérifier les dates d'expiration |

### 1b. Réglages à choisir

**Jeton fine-grained** (écran de création) :

1. **Token name** : `ai-business-os-deploy`
2. **Expiration** : 90 jours (ou « custom »)
3. **Resource owner** : ton compte
4. **Repository access** : `Only select repositories` → `ai-business-os`
5. **Permissions** → `Repository permissions` → **Contents : Read and write** (obligatoire)
   et **Metadata : Read-only** (ajouté automatiquement)
6. **Generate token** → **copie le jeton immédiatement** (`github_pat_…`), il ne sera plus jamais affiché

**Jeton classique** : coche simplement la case **`repo`**, puis *Generate token*
(le jeton commence par `ghp_…`).

### 1c. Utiliser le jeton

```bash
# Option A — le plus simple : tu le colles quand Git le demande
git push -u origin main
#   Username: ton-nom-utilisateur-github
#   Password: colle le JETON ici (pas ton mot de passe GitHub)

# Option B — l'enregistrer dans l'URL du dépôt (moins pratique, visible dans git remote -v)
git remote set-url origin https://TON-UTILISATEUR:TON_JETON@github.com/TON-UTILISATEUR/ai-business-os.git

# Option C — mémoriser les identifiants une fois pour toutes
git config --global credential.helper store
```

### 1d. Variante clé SSH (pas d'expiration à gérer)

```bash
ssh-keygen -t ed25519 -C "ton-email@exemple.com"     # Entrée pour accepter le chemin par défaut
cat ~/.ssh/id_ed25519.pub                            # copie la ligne affichée
```

Puis colle cette ligne sur **https://github.com/settings/keys** → *New SSH key*.

```bash
git remote set-url origin git@github.com:TON-UTILISATEUR/ai-business-os.git
ssh -T git@github.com     # doit répondre : "Hi … You've successfully authenticated"
git push -u origin main
```

### 1e. Encore plus simple : la CLI GitHub

```bash
# Installation : https://cli.github.com  (ou « brew install gh », « sudo apt install gh »)
gh auth login          # choisit « GitHub.com » puis « HTTPS » puis « Login with a web browser »
gh repo create ai-business-os --private --source=. --push
```

`gh auth login` gère le jeton tout seul : plus besoin de le recopier.

### 1f. Règles de sécurité

- Un jeton = un mot de passe : ne le colle **jamais** dans un chat, un e-mail, un fichier suivi par Git.
- Il doit être révoqué immédiatement en cas de doute : https://github.com/settings/tokens
- Ne le mets pas dans une URL de dépôt si tu partages ton écran (`git remote -v` l'afficherait).

---

## 2. Clés Stripe — pour encaisser les abonnements

Les liens se trouvent dans ton tableau de bord Stripe :

| Clé | Lien | Usage dans le projet |
|---|---|---|
| **Clé secrète TEST** (`sk_test_…`) | **https://dashboard.stripe.com/test/apikeys** | Variable `STRIPE_SECRET_KEY` — **recommandé pour commencer** (aucun argent réel) |
| **Clé secrète LIVE** (`sk_live_…`) | **https://dashboard.stripe.com/apikeys** | À mettre **après** la recette complète |
| Clé publiable (facultatif) | mêmes liens, ligne « Clé publiable » | `STRIPE_PUBLISHABLE_KEY` — non nécessaire au module actuel |
| Secret de webhook (`whsec_…`) | **https://dashboard.stripe.com/test/webhooks** | Variable `STRIPE_WEBHOOK_SECRET` — **indispensable** |

Marche à suivre complète :

1. Récupère `sk_test_…` sur **https://dashboard.stripe.com/test/apikeys**
2. Crée le catalogue (produits + prix) dans ton compte :

   ```bash
   STRIPE_SECRET_KEY=sk_test_xxx APP_URL=https://ton-domaine.com npm run stripe:setup
   ```

   Le script affiche les `STRIPE_PRICE_ID_*` et crée l'endpoint de webhook.
3. Copie le `whsec_…` depuis **https://dashboard.stripe.com/test/webhooks** dans `STRIPE_WEBHOOK_SECRET`
4. Vérifie : `npm run stripe-verify-account`
5. Le RIB de versement (ton argent) se renseigne ici : **https://dashboard.stripe.com/settings/payouts**

⚠️ **Ordre de sécurité** : ne mets jamais la clé `sk_live_…` en variable `NEXT_PUBLIC_*`, et ne la
commits jamais. Le code refuse d'ailleurs de démarrer avec une clé live hors production.

---

## 3. Récapitulatif — quels secrets vont où

| Valeur | Où l'obtenir | Où la mettre | Sur Git ? |
|---|---|---|---|
| Jeton GitHub `ghp_…` / `github_pat_…` | github.com/settings/tokens | Gestionnaire d'identifiants Git | **Jamais** |
| `STRIPE_SECRET_KEY` | dashboard.stripe.com/test/apikeys | `.env` / variables d'hébergeur | **Jamais** |
| `STRIPE_WEBHOOK_SECRET` | dashboard.stripe.com/test/webhooks | `.env` / variables d'hébergeur | **Jamais** |
| `APP_SECRET` | `openssl rand -hex 32` | `.env` / variables d'hébergeur | **Jamais** |
| `DATABASE_URL` | ton hébergeur PostgreSQL | `.env` / variables d'hébergeur | **Jamais** |
| IBAN de versement | ton relevé bancaire | **dashboard.stripe.com/settings/payouts** | **Jamais** |
| IBAN de réception clients | ton relevé bancaire | `/admin/settings` (ou `BANK_*`) | **Jamais** |
| `STRIPE_PRICE_ID_*` | créés par `npm run stripe:setup` | `.env` / variables d'hébergeur | Non (mais non sensibles) |

Le fichier `.gitignore` du projet exclut déjà tout ce qui est marqué « Jamais » : vérifie-le avant
chaque premier envoi sur un nouveau dépôt.

# Mettre le projet sur Git (ou ailleurs) — mode d'emploi

Deux fichiers sont prêts à déposer, à la racine de l'espace de travail :

| Fichier | Taille | À quoi il sert |
|---|---|---|
| **`ai-business-os-module-paiement.zip`** | ~190 Ko | **Le plus simple.** Archive complète (code, docs, Docker, tests). À téléverser, à envoyer par e-mail, à déposer sur Drive… |
| **`ai-business-os.bundle`** | ~185 Ko | Version « dépôt Git » en un seul fichier : historique complet inclus. À cloner ou à pousser sur GitHub/GitLab. |

⚠️ **Les deux fichiers ne contiennent AUCUN secret** : le `.env` (clés Stripe, `APP_SECRET`, IBAN) est
volontairement exclu. Les modèles `.env.example` et `.env.production.template` sont fournis à la place.

---

## Option 1 — GitHub en 3 minutes (recommandé)

### 1a. Créer le dépôt

1. Va sur **https://github.com/new**
2. Nom : `ai-business-os` — Visibilité : **Private** (recommandé, le code est ton actif)
3. **Ne cochez rien** (pas de README, pas de .gitignore : ils existent déjà dans le projet)
4. Clique sur **Create repository**

### 1b. Envoyer le code

**Depuis ta machine**, dans le dossier du projet décompressé :

```bash
cd ai-business-os

# Si tu as pris le ZIP : initialiser le dépôt local
git init -b main
git add -A
git commit -m "Module paiement Stripe pour AI Business OS"

# Relier à GitHub (remplace TON-COMPTE)
git remote add origin https://github.com/TON-COMPTE/ai-business-os.git   # ou git@github.com:TON-COMPTE/ai-business-os.git
git push -u origin main
```

**Si tu as pris le bundle** (l'historique est déjà dedans) :

```bash
git clone ai-business-os.bundle ai-business-os
cd ai-business-os
git remote set-url origin https://github.com/TON-COMPTE/ai-business-os.git
git push -u origin main
```

### 1c. Vérifier que le `.env` n'est PAS parti

Sur GitHub, ouvre le dépôt : tu dois voir `.env.example` mais **jamais** `.env`.
En local, la commande de contrôle est :

```bash
git status --short | grep "\.env$" || echo "OK : .env n'est pas suivi"
```

Si tu as poussé un `.env` par erreur : régénère immédiatement ta clé Stripe
(`sk_…`) dans le tableau de bord Stripe, elle doit être considérée comme compromise.

---

## Option 2 — Sans Git : dépôt manuel de l'archive

Si tu veux juste « poser le projet quelque part », le ZIP suffit :

| Destination | Comment | À savoir |
|---|---|---|
| **Google Drive / Dropbox / OneDrive** | Glisse le ZIP | Pratique comme sauvegarde ; pas de déploiement automatique |
| **GitHub (upload web)** | Dépôt → *Add file* → *Upload files* → glisse le ZIP décompressé | Fonctionne, mais perd l'historique et ne permet pas d'automatiser les mises à jour |
| **Ton serveur** | `scp ai-business-os-module-paiement.zip user@serveur:/opt/` puis `unzip` | Puis `docker compose up -d --build` (voir `docs/DEPLOIEMENT.md`) |
| **Plateforme d'hébergement** | Railway / Render / Fly.io exigent un dépôt Git → passe d'abord par l'option 1 | C'est le chemin le plus rapide vers une URL permanente |

---

## Et ensuite : héberger avec une adresse permanente

Une fois le code sur GitHub, le déploiement devient immédiat :

- **Railway** : New Project → Deploy from GitHub → ajoute un service PostgreSQL → renseigne les
  variables (`APP_URL`, `APP_SECRET`, `STRIPE_*`, `DEMO_LOGIN=false`) → URL HTTPS fournie automatiquement.
- **Render** : New Web Service → dépôt → Runtime **Docker** → PostgreSQL managé → mêmes variables.
- **VPS** : `git clone` sur le serveur puis `docker compose up -d --build` + reverse proxy Caddy.

Détail pas à pas : **`docs/DEPLOIEMENT.md`** (options A/B/C, configuration Stripe, dépannage).

---

## Checklist avant de publier le dépôt

- [ ] `.gitignore` présent (il l'est) et `.env` exclu — vérifié automatiquement
- [ ] Le dépôt GitHub est en **Private** tant que le projet n'est pas prêt à être public
- [ ] Aucun fichier `*.sql` / `*.dump` (sauvegardes contenant des données clients) n'est suivi
- [ ] `README.md` à jour (il l'est : démarrage, traçabilité des exigences, commandes)
- [ ] Sur le site déployé : `DEMO_LOGIN="false"` et `ALLOW_SIMULATION="false"`
- [ ] Clés Stripe en `sk_test_…` jusqu'à la fin de la recette, puis `sk_live_…`

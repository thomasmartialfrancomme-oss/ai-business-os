# Tout ce qu'il faut préparer (RIB, clés, comptes) et où le mettre

Guide destiné au **propriétaire de la plateforme**. Il liste tout ce que tu dois fournir, où
l'enregistrer, et ce qu'il ne faut jamais saisir.

> **En mode simulation (état actuel), rien n'est nécessaire** : le module fonctionne déjà sans compte
> Stripe et sans RIB. Ce document sert à passer à l'encaissement réel.

---

## 0. Le point le plus important : il y a DEUX RIB différents

C'est l'erreur la plus fréquente. Ne les confonds pas.

| | **RIB n°1 — VERSEMENT** (ton argent) | **RIB n°2 — RÉCEPTION** (virements de tes clients) |
|---|---|---|
| À quoi il sert | Stripe t'envoie **ton** argent après les encaissements | Affiché aux clients pro qui choisissent « payer par virement bancaire » |
| Où il se met | **Dans Stripe** : Paramètres → Virements → Compte bancaire | **Dans l'application** : `/admin/settings` (ou variables `BANK_*`) |
| Qui le voit | Toi, dans Stripe | Tes clients, sur la facture de virement |
| Stocké par l'application ? | **Jamais** (aucun IBAN de versement en base) | Oui (nécessaire pour l'afficher) |
| Modifiable après coup ? | Oui, dans Stripe | Oui, dans `/admin/settings`, sans redéploiement |
| Cadence de versement | Quotidienne / hebdomadaire / mensuelle (dans Stripe) | — |

👉 Si tu ne veux pas proposer le virement bancaire à tes clients, ignore simplement le RIB n°2 :
le bouton « Payer par virement bancaire » affichera un message d'indisponibilité (c'est prévu et testé).

---

## 1. À avoir sous la main avant de commencer

| # | Élément | Où / comment l'obtenir |
|---|---|---|
| 1 | Accès au **compte Stripe du propriétaire** (e-mail + mot de passe) | dashboard.stripe.com — c'est **ce** compte qui encaisse tout |
| 2 | Vérification d'identité / activité (KYC) | Stripe → Paramètres → Détails de l'entreprise (pièce d'identité, justificatif d'activité) |
| 3 | **RIB n°1** : IBAN + BIC du compte de versement | Ton relevé bancaire / ton espace client en ligne |
| 4 | **RIB n°2** (facultatif) : IBAN + BIC de réception | Idem (souvent le même que n°1) |
| 5 | Raison sociale + adresse + SIRET/TVA | Pour les factures émises par Stripe |
| 6 | **Domaine HTTPS** de production | Indispensable pour que Stripe livre les webhooks |
| 7 | **Base PostgreSQL** de production | Chez ton hébergeur (chaîne de connexion `postgresql://…`) |
| 8 | Un **secret d'application** | Généré par toi : `openssl rand -hex 32` |
| 9 | Clés Stripe (`sk_test_…` puis `sk_live_…`) | Stripe → Développeurs → Clés API |
| 10 | Secret de webhook (`whsec_…`) | Stripe → Développeurs → Webhooks → ton endpoint |

---

## 2. Toutes les variables à renseigner (fichier `.env` ou variables de l'hébergeur)

| Variable | Obligatoire | Où la trouver | Exemple |
|---|---|---|---|
| `DATABASE_URL` | ✅ | Hébergeur PostgreSQL | `postgresql://user:pass@host:5432/aibos` |
| `APP_URL` | ✅ | Ton domaine public HTTPS | `https://app.ai-business-os.com` |
| `APP_SECRET` | ✅ | `openssl rand -hex 32` | `9f2c…` (64 caractères) |
| `STRIPE_SECRET_KEY` | ✅ en réel | Stripe → Développeurs → Clés API | `sk_live_…` (ou `sk_test_…` en test) |
| `STRIPE_WEBHOOK_SECRET` | ✅ en réel | Stripe → Webhooks → ton endpoint | `whsec_…` |
| `OWNER_EMAIL` | ✅ | Ton adresse de propriétaire | `contact@ai-business-os.com` |
| `STRIPE_PRICE_ID_STARTER_MONTH` | ✅ | créé par `npm run stripe:setup` | `price_…` |
| `STRIPE_PRICE_ID_STARTER_YEAR` | ✅ | idem | `price_…` |
| `STRIPE_PRICE_ID_PRO_MONTH` | ✅ | idem | `price_…` |
| `STRIPE_PRICE_ID_PRO_YEAR` | ✅ | idem | `price_…` |
| `STRIPE_PRICE_ID_BUSINESS_MONTH` | ✅ | idem | `price_…` |
| `STRIPE_PRICE_ID_BUSINESS_YEAR` | ✅ | idem | `price_…` |
| `ALLOW_SIMULATION` | ✅ | à mettre à `false` en production | `false` |
| `ANNUAL_DISCOUNT_PERCENT` | ⬜ (20 par défaut) | ta décision commerciale (0–90) | `20` |
| `PAST_DUE_GRACE_DAYS` | ⬜ (3 par défaut) | ta décision commerciale | `3` |
| `BANK_ACCOUNT_HOLDER` | ⬜ | **RIB n°2** — titulaire du compte de réception | `AI Business OS SAS` |
| `BANK_NAME` | ⬜ | RIB n°2 — banque et agence | `Banque X — Agence Saint-Denis` |
| `BANK_IBAN` | ⬜ | RIB n°2 | `FR76 3000 6000 0112 3456 7890 189` |
| `BANK_BIC` | ⬜ | RIB n°2 | `AGRIFRPPXXX` |
| `BANK_ADDRESS` | ⬜ | RIB n°2 — adresse de la banque | `12 rue de la Paix, 97400 Saint-Denis` |
| `BANK_ROUTING_NOTE` | ⬜ | consigne affichée au client | `Virement SEPA/SWIFT. Indiquez la référence AIB-… en libellé.` |
| `STRIPE_PUBLISHABLE_KEY` | ⬜ | Stripe → Clés API | réservée à un usage futur (le module n'en a pas besoin aujourd'hui) |

**Développement / tests uniquement** (jamais en production) :
`DATABASE_URL_TEST` (base de test pour `npm test`) et `SIM_DELIVER_VIA_HTTP=true` (livrer les webhooks
simulés par HTTP au lieu d'en processus).

⚠️ **Ordre de priorité pour les coordonnées de réception** : ce qui est saisi dans `/admin/settings`
est lu **avant** les variables `BANK_*`. Si tu remplis les deux, c'est l'interface qui gagne.

---

## 3. Fiche à remplir (copie-la et garde-la de côté)

```
── Société (pour les factures Stripe) ─────────────────────────────
Raison sociale        : ______________________________________
Adresse               : ______________________________________
SIRET / TVA           : ______________________________________
E-mail de facturation : ______________________________________
Préfixe de factures   : AIBOS-2026- (défini dans Stripe)

── RIB n°1 : VERSEMENT (à saisir dans STRIPE, pas dans l'app) ─────
Titulaire             : ______________________________________
IBAN                  : ______________________________________
BIC                   : ______________________________________
Cadence souhaitée     : ☐ quotidienne  ☐ hebdomadaire  ☐ mensuelle

── RIB n°2 : RÉCEPTION des virements clients (facultatif) ─────────
Utilisé ?             : ☐ oui  ☐ non
Titulaire             : ______________________________________
Banque / agence       : ______________________________________
IBAN                  : ______________________________________
BIC                   : ______________________________________
Adresse de la banque  : ______________________________________
Consigne client       : ______________________________________

── Domaine / technique ────────────────────────────────────────────
Domaine HTTPS         : ______________________________________
Base PostgreSQL       : ______________________________________
```

---

## 4. Étapes dans Stripe (dans l'ordre)

1. **Créer / activer le compte** : dashboard.stripe.com → renseigner l'activité, l'adresse, la raison
   sociale, puis terminer la vérification d'identité (KYC). Sans cela, les encaissements et les
   virements restent bloqués.
2. **Moyens de paiement** : Paramètres → Moyens de paiement → activer **Cartes**, et au besoin
   **SEPA Direct Debit**, **Apple Pay / Google Pay**.
3. **RIB n°1 (versement)** : Paramètres → **Virements** → *Compte bancaire* → saisir l'IBAN + BIC.
   Puis choisir la **cadence de versement**. C'est ici, et nulle part ailleurs, que ton argent arrive.
4. **Facturation** : Paramètres → Facturation → logo, adresse, numéro de TVA, préfixe/nom des factures,
   langue (français), devise (**EUR**). Stripe émettra les PDF téléchargeables depuis `/billing`.
5. **Portail client** : ne rien faire à la main — `npm run stripe:setup` le configure (mise à jour du
   moyen de paiement, historique de factures, annulation en fin de période).
6. **Webhook** : Développeurs → Webhooks → Ajouter un endpoint
   - URL : `https://TON-DOMAINE/api/stripe/webhook`
   - Événements : `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
     `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`,
     `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed`,
     `invoice.payment_action_required`, `payment_intent.payment_failed`, `charge.refunded`
   - Copier le **`whsec_…`** → variable `STRIPE_WEBHOOK_SECRET`.
7. **Clés API** : Développeurs → Clés API → récupérer la clé secrète (`sk_test_…` d'abord, puis
   `sk_live_…` après la recette). La clé « publiable » n'est pas nécessaire ici.
8. **E-mails** : Paramètres → E-mails → activer les reçus de paiement et les relances d'échec
   (Stripe relance automatiquement une carte refusée).

---

## 5. Les deux commandes qui font la configuration

```bash
# 1. Crée les 6 prix (3 offres × mensuel/annuel) + le webhook + le portail DANS TON COMPTE
STRIPE_SECRET_KEY=sk_test_xxx APP_URL=https://ton-domaine.com npm run stripe:setup
#    → colle les STRIPE_PRICE_ID_* et le STRIPE_WEBHOOK_SECRET affichés dans .env, puis redémarre

# 2. Vérifie que tout est prêt (encaissement, virements, RIB, prix, webhook)
npm run stripe-verify-account
```

Le contrôle final doit afficher **tous les points en ✓**, notamment :

```
✓ Encaissement activé        ok
✓ Virements activés          ok
✓ Compte bancaire de versement  Banque X ••••1234 (EUR)
✓ Prix STARTER MONTH         price_… — 29.00 EUR
✓ Endpoint de webhook        https://ton-domaine.com/api/stripe/webhook — statut enabled
✓ Secret de signature        configuré
```

---

## 6. Checklist finale avant d'encaisser pour de vrai

- [ ] RIB n°1 saisi dans **Stripe → Virements**, KYC validé, « virements activés »
- [ ] Cadence de versement choisie (quotidienne / hebdomadaire / mensuelle)
- [ ] Les **6 `STRIPE_PRICE_ID_*`** sont dans les variables d'environnement
- [ ] `STRIPE_SECRET_KEY` = `sk_live_…` et `STRIPE_WEBHOOK_SECRET` = `whsec_…` (celui de l'endpoint live)
- [ ] `APP_URL` = domaine HTTPS réel, `ALLOW_SIMULATION=false`
- [ ] `APP_SECRET` = valeur aléatoire de 32+ caractères
- [ ] `npm run stripe-verify-account` : **tout en ✓**
- [ ] Un premier paiement réel de faible montant (29 €) testé, puis remboursé
- [ ] RIB n°2 enregistré dans `/admin/settings` **si** tu ouvres le paiement par virement
- [ ] Alerte activée sur les webhooks en échec (Stripe → Webhooks, ou supervision sur `webhook_events`)

---

## 7. Ce qu'il ne faut JAMAIS saisir (ni ici, ni ailleurs)

| Interdit | Raison |
|---|---|
| Numéro de carte, CVV, code 3D Secure | Traités **uniquement** par Stripe ; rien de tel n'existe en base (vérifié par tests) |
| IBAN / RIB **de tes clients** | Aucun besoin : les prélèvements passent par Stripe |
| Mot de passe ou clé secrète Stripe dans un e-mail, un chat ou un dépôt Git | Fuite = accès complet à ton compte |
| `sk_live_…` dans une variable `NEXT_PUBLIC_*` | Exposerait la clé au navigateur (le code refuse d'ailleurs de démarrer avec une clé live hors production) |
| Coordonnées bancaires dans un composant d'interface | Les coordonnées de réception vivent côté serveur |

L'IBAN de **versement** n'est volontairement stocké nulle part dans l'application : il reste dans
Stripe. Impossible donc qu'un bug applicatif détourne un virement.

---

## 8. Après la mise en service : où modifier quoi

| Ce que tu veux changer | Où | Effet |
|---|---|---|
| RIB de **réception** (virement client) | `/admin/settings` | Immédiat, sans redéploiement (les factures déjà émises gardent l'ancien IBAN, par sécurité) |
| RIB de **versement**, cadence | Stripe → Paramètres → Virements | Immédiat côté Stripe |
| Prix des offres | `src/lib/plans.ts` + `npm run stripe:setup` | Nouveaux prix appliqués aux nouvelles souscriptions |
| Réduction annuelle | variable `ANNUAL_DISCOUNT_PERCENT` | S'applique aux nouveaux checkout |
| Période de grâce après impayé | variable `PAST_DUE_GRACE_DAYS` | Immédiat après redémarrage |
| Moyens de paiement acceptés | Stripe → Paramètres → Moyens de paiement | Immédiat |

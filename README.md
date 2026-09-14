# AI Business OS — Module de paiement & abonnements

Module de paiement complet pour **AI Business OS** : abonnements STARTER / PRO / BUSINESS encaissés
**sur le compte Stripe du propriétaire de la plateforme**, activation uniquement après **webhook
Stripe vérifié**, espace de facturation client, tableau de bord de revenus, et paiement par
**virement bancaire** pour les clients professionnels.

> **Règle absolue appliquée par le code** : le frontend ne peut jamais déclarer « paiement réussi ».
> Le retour du navigateur n'active rien. Seul le backend écrit l'état d'un paiement, après vérification
> cryptographique de l'événement Stripe. L'écriture d'état est concentrée dans un seul fichier :
> `src/lib/payments/state.ts`.

---

## 1. Démarrage rapide

```bash
# 1. Dépendances
npm install

# 2. Base de données (PostgreSQL) — copiez .env.example en .env puis :
npm run db:push        # crée le schéma
npm run db:seed        # jeu de démonstration (propriétaire + 6 clients, cas réalistes)

# 3. Application (aucune clé Stripe requise : mode simulation)
npm run dev            # http://localhost:3000
```

Parcours à essayer immédiatement :

1. **`/login`** → connectez-vous en tant qu'`emma@exemple.fr` (aucun abonnement).
2. **`/pricing`** → « S'abonner — carte bancaire » sur le forfait **Pro (59 €/mois)**.
3. Vous arrivez sur la page de paiement (simulation locale de Stripe Checkout) → carte **4242 4242 4242 4242**.
4. Retour sur **`/billing/success`** : la page **constate** l'état, elle n'active rien. L'activation
   vient des trois webhooks signés livrés par le serveur.
5. **`/billing`** : plan actuel, prix, prochaine date de paiement, statut, historique, factures, boutons
   *Changer de forfait*, *Annuler l'abonnement*, *Mettre à jour le moyen de paiement*, *Voir mes factures*.
6. **`/sim`** : provoquez un renouvellement, un échec de paiement, ou rejouez un paiement (idempotence).
7. **`/admin/revenue`** (compte propriétaire) : revenus du mois, revenus totaux, abonnements actifs,
   nouveaux abonnements, annulations, paiements échoués, **MRR**, **ARR estimé**, solde Stripe, virements
   bancaires à confirmer, journal d'audit.

### Passer sur un vrai compte Stripe

```bash
# Catalogue créé dans VOTRE compte Stripe (produits + prix mensuels/annuels + webhook + portail)
STRIPE_SECRET_KEY=sk_test_xxx APP_URL=http://localhost:3000 npm run stripe:setup
# → collez les STRIPE_PRICE_ID_… et STRIPE_WEBHOOK_SECRET affichés dans .env, puis redémarrez.
```

Modes disponibles :

| Configuration | Mode | Comportement |
|---|---|---|
| `STRIPE_SECRET_KEY` vide | **simulation** | Parcours complet hors ligne, webhooks signés émis localement |
| `sk_test_…` | **test** | Environnement Stripe TEST, testeurs de cartes Stripe, webhooks réels |
| `sk_live_…` | **live** | Encaissement réel (refusé si `NODE_ENV != production`) |

---

## 2. Le parcours de paiement

```
Client                    Notre serveur                    Stripe
  │                            │                              │
  ├─ choisit PRO 59 €/mois ───▶│ POST /api/billing/checkout    │
  │                            ├─ recalcule le prix serveur     │
  │                            ├─ crée la session ─────────────▶│
  │                            │◀─────────── session + URL ─────┤
  │◀──── redirection vers la page de paiement Stripe ──────────┘
  ├─ saisit sa carte (chez Stripe uniquement)
  │                            │                              │
  │                            │◀── POST /api/stripe/webhook ───┤  (événement SIGNÉ)
  │                            ├─ vérifie la signature (SDK)    │
  │                            ├─ idempotence (event id)        │
  │                            ├─ relit l'abonnement à la source│
  │                            └─ écrit l'état en base          │
  │◀─ /billing/success : LECTURE seule de l'état (polling) ─────┤
  │   l'abonnement n'est activé que si le fournisseur le dit actif
```

**Événements traités** (`/api/stripe/webhook`) : `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `customer.subscription.created|updated|deleted|paused|resumed`,
`invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed`, `invoice.payment_action_required`,
`payment_intent.payment_failed`, `charge.refunded`.

---

## 3. Traçabilité des exigences

| Exigence | Où c'est implémenté |
|---|---|
| STARTER 29 €, PRO 59 €, BUSINESS 99 €/mois | `src/lib/plans.ts` |
| Prix annuels avec réduction configurable | `plans.ts` (`ANNUAL_DISCOUNT_PERCENT`, 20 % par défaut) |
| Session Checkout créée côté serveur | `src/lib/payments/service.ts` + `stripe-gateway.ts` |
| Redirection, paiement, retour | `src/app/pricing`, `src/app/billing/success` |
| Activation **uniquement** après confirmation du webhook | `src/lib/payments/state.ts` (seul écrivain) |
| Jamais de succès déduit du retour navigateur | `src/app/billing/success/page.tsx` + `SuccessPoller.tsx` (lecture seule) |
| Endpoint sécurisé `/api/stripe/webhook` | `src/app/api/stripe/webhook/route.ts` |
| Signature Stripe vérifiée | `src/lib/payments/webhook.ts` (SDK officiel, tolérance 5 min) |
| Idempotence (webhook répété) | contrainte unique `webhook_events.stripe_event_id` |
| `stripe_customer_id`, `stripe_subscription_id`, `stripe_price_id`, `subscription_status`, `current_period_start/end`, `cancel_at_period_end`, `last_payment_status` | `prisma/schema.prisma` → modèle `Subscription` |
| Espace client `/billing` | `src/app/billing/page.tsx` (+ `/billing/invoices`) |
| Boutons changer / annuler / moyen de paiement / factures | `src/components/BillingActions.tsx`, `PlanSelector.tsx`, portail Stripe |
| Espace admin `/admin/revenue` (mois, total, actifs, nouveaux, annulations, échecs, MRR, ARR) | `src/app/admin/revenue/page.tsx` + `src/lib/payments/metrics.ts` |
| Argent sur le compte Stripe **du propriétaire**, pas de Stripe Connect | `stripe-gateway.ts` (aucun appel `accounts.create`/Connect) |
| Versement vers le compte bancaire | configuré **dans Stripe** (`settings.payouts`), affiché dans `/admin/revenue` |
| Virement bancaire : coordonnées admin, référence unique, statut `AWAITING_BANK_TRANSFER` | `src/lib/payments/bank-transfer.ts` |
| Virement jamais payé automatiquement | `declareBankTransfer` (déclaration) vs `confirmBankTransfer` (OWNER + référence exacte) |
| Passage à `PAID` après confirmation fiable | `confirmBankTransfer` → facture `PAID`, paiement `BANK_TRANSFER`, abonnement activé |
| Ne jamais stocker carte / CVV / codes bancaires / mot de passe Stripe | schéma + tests de sécurité (`tests/security.test.ts`) |
| Clés Stripe côté serveur uniquement | `src/lib/env.ts` (aucun `NEXT_PUBLIC_*` pour les secrets) |
| Environnement TEST puis PRODUCTION | mode simulation → `sk_test_…` → `sk_live_…` (`docs/PRODUCTION.md`) |

---

## 4. Structure du projet

```
ai-business-os/
├─ prisma/
│  ├─ schema.prisma          # User, Subscription, Invoice, Payment, WebhookEvent, AuditLog, Settings
│  └─ seed.ts                # jeu de démonstration réaliste
├─ src/lib/
│  ├─ env.ts                 # configuration serveur + détection du mode Stripe
│  ├─ plans.ts               # catalogue, prix mensuels/annuels, réduction configurable
│  ├─ access.ts              # LA règle d'accès (active, grâce, résiliation, impayés)
│  ├─ audit.ts               # piste d'audit de toutes les décisions
│  └─ payments/
│     ├─ types.ts            # contrats (formes Stripe réelles) et interface PaymentGateway
│     ├─ state.ts            # ⚠️ MACHINE À ÉTATS — seul écrivain des abonnements/paiements
│     ├─ webhook.ts          # vérification de signature + idempotence + application
│     ├─ stripe-gateway.ts   # Stripe réel (votre compte, clé serveur)
│     ├─ sim-gateway.ts      # mode simulation (aucune clé requise)
│     ├─ fixtures.ts         # objets/événements Stripe au format réel
│     ├─ events.ts           # livraison des événements au webhook (simulation)
│     ├─ bank-transfer.ts    # virement bancaire (création, déclaration, confirmation admin)
│     └─ metrics.ts          # MRR, ARR, encaissements, échecs, timeline
├─ src/app/
│  ├─ pricing/  billing/  billing/success/  billing/invoices/
│  ├─ admin/revenue/  admin/settings/
│  ├─ sim/  sim/checkout/[sessionId]/
│  └─ api/stripe/webhook | api/billing/* | api/admin/* | api/sim/* | api/auth/session
├─ scripts/
│  ├─ stripe-setup.ts        # crée produits/prix/webhook/portail dans VOTRE compte Stripe
│  ├─ stripe-verify-account.ts # contrôle avant production (encaissement, virements, prix)
│  ├─ run-tests.ts           # lanceur de la suite complète
│  └─ smoke-http.sh          # tests HTTP sur un serveur en marche
├─ tests/                    # 36 tests (scénarios, sécurité, unitaires)
├─ Dockerfile · docker-compose.yml · docker/entrypoint.sh   # déploiement
├─ .env.production.template  # modèle de configuration production
└─ docs/                     # DEPLOIEMENT.md, CHECKLIST-PROPRIETAIRE.md,
                             # PRODUCTION.md, SECURITY.md, TESTING.md
```

---

## 5. Commandes

| Commande | Rôle |
|---|---|
| `npm run dev` / `npm run build` / `npm start` | développement / compilation / production |
| `npm run db:push` · `npm run db:seed` · `npm run db:reset` | schéma · données de démo · remise à zéro |
| `npm test` | suite complète (36 tests) sur une base de test dédiée |
| `npm run typecheck` | vérification TypeScript stricte |
| `npm run stripe:setup` | provisionne catalogue + webhook + portail dans votre compte Stripe |
| `npm run stripe:verify-account` | contrôle du compte avant passage en production |
| `bash scripts/smoke-http.sh` | tests HTTP sur un serveur en marche (27 vérifications) |
| `bash scripts/start-local.sh` | démarre base + application (répare PostgreSQL si besoin) |
| `docker compose up -d --build` | pile complète conteneurisée (app + PostgreSQL) |

---

## 6. Validation

```
npm test                                  → 36/36 tests réussis
bash scripts/smoke-http.sh                → 27/27 vérifications réussies
```

Scénarios couverts (exigés) : paiement réussi, paiement refusé, abonnement créé, abonnement renouvelé,
paiement échoué (relance puis suspension), annulation, changement de forfait, remboursement,
webhook invalide (signature absente, falsifiée, expirée), webhook répété (idempotence), événement hors
ordre, virement bancaire (déclaration ≠ paiement), plus les tests de sécurité d'architecture.
Détail dans **`docs/TESTING.md`**.

---

## 7. Où va l'argent

1. Le client paie son abonnement → **encaissé sur votre compte Stripe** (le compte correspondant à
   `STRIPE_SECRET_KEY`).
2. **Aucun compte Stripe Connect n'est créé** pour les clients : votre compte est le seul destinataire.
3. Stripe **verse automatiquement** le solde sur le compte bancaire configuré dans
   *Stripe → Paramètres → Virements*. Cette étape reste chez Stripe, par conception : l'application ne
   stocke aucun IBAN de versement et ne peut pas détourner de fonds.
4. Le solde disponible et le compte bancaire associé sont affichés en lecture seule dans `/admin/revenue`.

Pour le virement bancaire côté client (offre destinée aux entreprises), les coordonnées de **réception**
sont saisies par le propriétaire dans `/admin/settings` : `src/lib/payments/bank-transfer.ts`.

---

## 8. Sécurité en une page

- Signature des webhooks vérifiée par le SDK officiel Stripe (`constructEvent`, tolérance 300 s),
  en-tête absent ou invalide → `400`, aucune écriture.
- Idempotence par identifiant d'événement (un rejeu n'a aucun effet) + garde anti-régression sur les
  événements livrés hors ordre.
- Aucune donnée de carte, aucun CVV, aucun code bancaire, aucun mot de passe Stripe en base ou dans les
  journaux — vérifié automatiquement par les tests de sécurité.
- Actions sensibles : contrôle d'origine (CSRF), limitation de débit, session signée HMAC, rôle `OWNER`
  exigé pour `/admin` (401/403 explicites côté API).
- Montants toujours recalculés côté serveur (un montant envoyé par le navigateur est ignoré).
- Virement bancaire : déclaration client ≠ paiement ; confirmation réservée au propriétaire avec
  référence exacte et journalisation.

Détail complet : **`docs/SECURITY.md`**.

---

## 9. Obtenir une adresse permanente

L'aperçu de l'espace de travail est **temporaire** (environnement jetable, lien susceptible d'expirer).
Pour une adresse stable et partageable :

```bash
cp .env.production.template .env   # renseignez APP_SECRET ; DEMO_LOGIN="true" pour garder la démo
docker compose up -d --build       # base PostgreSQL + application, en une commande
# → http://localhost:3000
```

Pour un vrai domaine avec HTTPS, une plateforme gérée ou derrière un reverse proxy :
**`docs/DEPLOIEMENT.md`** (options A/B/C, configuration Stripe, dépannage).

## 10. Notes de mise en production

Voir **`docs/PRODUCTION.md`** : création du catalogue Stripe, endpoint de webhook, portail de
facturation, compte bancaire de versement, bascule `sk_live_…`, tests de fumée avec un vrai paiement
de faible montant, puis supervision.

> ⚠️ Avant de passer en production : remplacer l'authentification de démonstration
> (`src/lib/auth.ts`, cookie signé) par votre fournisseur d'identité réel, et migrer la base de données
> avec `prisma migrate deploy` plutôt que `db push`.

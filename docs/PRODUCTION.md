# Mise en production

Procédure complète : de l'environnement TEST validé jusqu'à l'encaissement réel avec versement sur le
compte bancaire du propriétaire de la plateforme.

> Prérequis : la suite doit être verte (`npm test` → 36/36) et les tests HTTP passés
> (`bash scripts/smoke-http.sh` → 27/27). Ne passez pas à l'étape 5 avant.

---

## Étape 0 — Ce qu'il faut avoir sous la main

| Élément | Où l'obtenir |
|---|---|
| Compte Stripe du **propriétaire** | dashboard.stripe.com (c'est le seul compte destinataire des fonds) |
| Vérification d'identité (KYC) et compte bancaire de versement | Stripe → Paramètres → Virements |
| Domaine public HTTPS | votre hébergeur (nécessaire pour les webhooks) |
| Base PostgreSQL de production | votre hébergeur |
| `APP_SECRET` | `openssl rand -hex 32` |

---

## Étape 1 — Environnement TEST d'abord

```bash
STRIPE_SECRET_KEY=sk_test_xxxx APP_URL=http://localhost:3000 npm run stripe:setup
```

Le script crée dans **votre** compte Stripe : les 6 prix (3 offres × mensuel/annuel), l'endpoint de
webhook si `APP_URL` est public, et la configuration du portail de facturation. Il affiche les
`STRIPE_PRICE_ID_*` et le `STRIPE_WEBHOOK_SECRET` à copier dans `.env`. Il est **idempotent** : le
relancer ne duplique rien.

Développement local des webhooks :

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
# copiez la ligne « whsec_… » affichée dans STRIPE_WEBHOOK_SECRET
```

Testez avec les cartes de test Stripe : `4242 4242 4242 4242` (succès), `4000 0000 0000 0002`
(refus), `4000 0000 0000 9995` (provision insuffisante), `4000 0000 0000 3220` (3D Secure).

Vérifiez dans le tableau de bord Stripe TEST que les paiements apparaissent bien sur **votre** compte
(onglet Paiements) et que les événements webhook sont bien livrés (onglet Développeurs → Webhooks).

---

## Étape 2 — Compte bancaire de versement (dans Stripe, pas dans l'app)

1. Stripe → **Paramètres → Virements → Compte bancaire** : renseignez l'IBAN du propriétaire.
2. Choisissez la **cadence de versement** (quotidienne, hebdomadaire, mensuelle ou manuelle).
3. Le tableau de bord `/admin/revenue` affichera le solde disponible, le solde en attente et le compte
   bancaire associé (masqué : `••••1234`) — en **lecture seule**.

L'application ne stocke aucun IBAN de versement et n'exécute aucun virement : cette responsabilité
reste chez Stripe, ce qui évite toute manipulation de fonds côté code.

---

## Étape 3 — Préparation de l'application

```bash
npm ci
npx prisma migrate deploy      # ou, à défaut de migrations versionnées : prisma db push
npm run build
npm start                      # vérifier http://votre-domaine
```

Variables d'environnement de production (à définir dans votre hébergeur, jamais dans le dépôt) :

```dotenv
DATABASE_URL="postgresql://…"
APP_URL="https://votre-domaine.com"
APP_SECRET="…"                     # openssl rand -hex 32
STRIPE_SECRET_KEY="sk_test_…"       # à basculer en sk_live_… à l'étape 5
STRIPE_WEBHOOK_SECRET="whsec_…"
ALLOW_SIMULATION="false"            # la simulation reste désactivée en production
ANNUAL_DISCOUNT_PERCENT="20"
PAST_DUE_GRACE_DAYS="3"
BANK_ACCOUNT_HOLDER="…"             # coordonnées de réception pour les virements clients
BANK_NAME="…"
BANK_IBAN="…"
BANK_BIC="…"
```

Points de vigilance :

- `ALLOW_SIMULATION="false"` : les routes `/api/sim/*` doivent renvoyer 404 en production.
- Remplacez l'authentification de démonstration (`src/lib/auth.ts`) par votre fournisseur d'identité.
- Passez le rate limiting sur un stockage partagé (Redis) si vous exécutez plusieurs instances.

---

## Étape 4 — Endpoint de webhook de production

1. Stripe → **Développeurs → Webhooks → Ajouter un endpoint** :
   - URL : `https://votre-domaine.com/api/stripe/webhook`
   - Événements à écouter :
     - `checkout.session.completed`
     - `checkout.session.async_payment_succeeded`
     - `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
     - `invoice.paid`, `invoice.payment_succeeded`
     - `invoice.payment_failed`, `invoice.payment_action_required`
     - `payment_intent.payment_failed`
     - `charge.refunded`
2. Copiez le `whsec_…` **de cet endpoint** dans `STRIPE_WEBHOOK_SECRET` et redéployez.
3. Envoyez un événement de test depuis le tableau de bord : la réponse attendue est `200`.

Contrôle de cohérence :

```bash
npm run stripe-verify-account
# ✓ encaissement activé, ✓ virements activés, ✓ compte bancaire présent, ✓ 6 prix conformes,
# ✓ endpoint webhook déclaré, ✓ secret de signature configuré
```

---

## Étape 5 — Bascule en mode LIVE

1. Activez le mode Live dans Stripe, complétez la vérification d'identité, puis récupérez la clé
   `sk_live_…`.
2. Recréez le catalogue en live (les objets TEST et LIVE sont totalement séparés) :

   ```bash
   STRIPE_SECRET_KEY=sk_live_xxxx APP_URL=https://votre-domaine.com npm run stripe:setup
   ```

3. Mettez à jour les `STRIPE_PRICE_ID_*` (préfixe live) et le `STRIPE_WEBHOOK_SECRET` de l'endpoint
   live, puis `STRIPE_SECRET_KEY=sk_live_…`, et redéployez avec `NODE_ENV=production`.
4. Le badge de l'interface doit afficher **Stripe LIVE** et `/sim` doit avoir disparu.

---

## Étape 6 — Recette de production (obligatoire)

Effectuez ces vérifications avec un vrai moyen de paiement :

1. **Abonnement réel de faible enjeu** : souscrivez au forfait Starter (29 €) avec une carte réelle.
2. Vérifiez que `/billing/success` reste en « vérification » puis passe à « activé » — **jamais** avant
   réception du webhook.
3. Dans Stripe : le paiement est bien sur **votre** compte, l'abonnement est `active`, la facture est
   `paid`.
4. Dans `/admin/revenue` : encaissement du mois, MRR et ARR cohérents ; solde disponible en hausse.
5. **Annulation** : `/billing` → « Annuler l'abonnement » → l'accès reste actif jusqu'à l'échéance,
   `cancel_at_period_end` = vrai dans Stripe.
6. **Remboursement** : `/admin/revenue` → « Rembourser » → l'événement `charge.refunded` met la facture
   et le paiement à jour.
7. **Virement bancaire** : demandez une facture de virement, vérifiez que l'accès reste fermé, puis
   confirmez-la depuis `/admin/revenue` avec la référence exacte après réception des fonds.
8. **Versement** : vérifiez que Stripe programme le virement vers votre compte bancaire (cadence
   choisie) et qu'il apparaît dans Stripe → Virements.

---

## Étape 7 — Supervision

| À surveiller | Comment |
|---|---|
| Webhooks en échec | alerte sur `webhook_events.status = 'FAILED'` (ou Stripe → Webhooks → taux d'échec) |
| Abonnements en retard | `/admin/revenue` (MRR à risque) et rappels Stripe automatiques |
| Remboursements / litiges | Stripe → Paiements (les litiges restent gérés dans Stripe) |
| Solde et versements | `/admin/revenue` (solde disponible, en attente, cadence) |

Stripe réessaie automatiquement les webhooks en échec pendant plusieurs jours ; notre handler est
idempotent, donc un rejeu ne provoque jamais de double activation.

---

## Retour arrière (rollback)

- **Revenir en TEST** : remettre `sk_test_…` + les prix de test et redéployer. Les abonnements live
  continuent de fonctionner côté Stripe et continueront d'envoyer des webhooks : ne laissez pas cet état
  durablement, ou utilisez un environnement de préproduction dédié.
- **Désactiver l'encaissement** : dans Stripe, mettez l'endpoint de webhook en pause pour geler les
  mises à jour d'état, ou désactivez les prix pour empêcher toute nouvelle souscription.
- **Aucun accès n'est jamais accordé sans webhook** : si l'application est arrêtée, aucun client ne peut
  être activé à tort ; au redémarrage, resynchronisez via `/billing` → « Synchroniser l'état » ou laissez
  Stripe rejouer ses événements.

---

## Ce qui n'est PAS fait (et pourquoi)

- **Pas de Stripe Connect** : les clients paient sur le compte Stripe du propriétaire. Ce choix est
  explicite dans le cahier des charges et évite de multiplier les comptes marchands. Il ne serait à
  revoir que si le modèle économique devenait une marketplace.
- **Pas de stockage de moyen de paiement** : tout est chez Stripe (Checkout + portail). C'est ce qui
  garantit l'absence de périmètre PCI-DSS côté application.
- **Pas de virement automatique déclenché par le code** : les versements sont pilotés par Stripe selon
  la cadence choisie.

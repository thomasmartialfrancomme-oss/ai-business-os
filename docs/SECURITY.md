# Sécurité du module de paiement

Document de référence : ce qui est protégé, comment, et ce qui est délibérément hors de notre périmètre.

---

## 1. La règle absolue (et comment elle est garantie)

> Le frontend ne peut jamais déclarer « paiement réussi ». Seul le backend, après vérification de
> l'événement Stripe, peut modifier l'état du paiement.

Trois garanties concrètes, vérifiées automatiquement :

| Garantie | Mécanisme | Vérification |
|---|---|---|
| Un seul écrivain | `prisma.subscription.*` n'existe que dans `src/lib/payments/state.ts` et `bank-transfer.ts` | test « seuls les modules de paiement écrivent l'état d'un abonnement » |
| Aucune écriture depuis une page | `/billing/success` interroge une route **GET** de lecture seule | test « la route de statut est strictement en lecture seule » |
| Aucun état « payé » dans l'interface | aucun composant ne contient `status: "ACTIVE"` / `payment_status: "paid"` | test « aucun composant d'interface ne peut déclarer un paiement réussi » |

Conséquence pratique : même si un client appelle directement l'API, s'il rejoue une URL de succès, ou
s'il modifie les réponses réseau dans son navigateur, **aucun accès n'est accordé**. La seule écriture
possible est l'intention de checkout (`registerCheckoutIntent`), qui crée un abonnement au statut
`INCOMPLETE` — donc sans accès (`src/lib/access.ts`).

---

## 2. Webhooks

**Endpoint** : `POST /api/stripe/webhook`

Ordre de traitement imposé, sans exception :

1. **Corps brut conservé** (`request.text()`) : la signature porte sur les octets exacts.
2. **Vérification de signature** par le SDK officiel (`stripe.webhooks.constructEvent`) — HMAC-SHA256
   avec `STRIPE_WEBHOOK_SECRET`, tolérance d'horodatage 300 secondes (protection contre le rejeu d'un
   ancien événement intercepté). Aucune réimplémentation maison.
3. **Cohérence d'environnement** : un événement `livemode: true` reçu sur un environnement de test
   (ou l'inverse) est rejeté — un encaissement réel ne peut pas écrire dans la base de test.
4. **Idempotence** : insertion de `webhook_events.stripe_event_id` (contrainte unique). Un rejeu renvoie
   `200 { duplicate: true }` sans le moindre effet.
5. **Anti-régression temporelle** : un événement plus ancien que le dernier appliqué est ignoré
   (`last_stripe_event_at`) et journalisé — Stripe ne garantit pas l'ordre de livraison.
6. **Application** : `state.ts`, seule écriture autorisée, avec relecture à la source quand l'événement
   ne contient pas tout l'état (ex. `checkout.session.completed`).

Réponses : `400` signature manquante/invalide ou environnement incohérent (aucune écriture) —
`200` traité ou déjà traité — `500` erreur de traitement (Stripe réessaie avec back-off).

**Cas particulier** : `checkout.session.completed` avec `payment_status != "paid"` n'active rien. Et
l'activation exige en plus que le statut **côté fournisseur** soit actif : on relit l'abonnement à la
source avant d'écrire `ACTIVE`.

---

## 3. Données sensibles

**Jamais stocké, jamais journalisé** :

- numéro de carte (PAN), CVV/CVC, date d'expiration, piste magnétique ;
- identifiants bancaires du client (comptes de prélèvement) ;
- mot de passe, clé, ou jeton du compte Stripe ;
- IBAN du compte de **versement** du propriétaire (il vit dans Stripe, pas ici).

**Ce qui est stocké** : uniquement des identifiants opaques fournis par Stripe (`cus_…`, `sub_…`,
`price_…`, `pi_…`, `ch_…`, `in_…`, `evt_…`), des montants en centimes entiers, des statuts, des
horodatages, et l'URL de la facture hébergée par Stripe.

**Exception documentée** : les coordonnées bancaires de **réception** (IBAN/BIC du propriétaire) saisies
dans `/admin/settings` sont stockées — ce sont les coordonnées affichées aux clients qui paient par
virement, jamais un moyen de paiement client. Le journal d'audit n'enregistre que les 4 derniers
caractères de l'IBAN.

Ces deux règles sont contrôlées par les tests « aucun champ de carte bancaire dans le schéma » et
« aucun code source n'enregistre de numéro de carte ou de CVV ».

**Cartes** : la saisie a lieu chez Stripe (Stripe Checkout, portail de facturation). En mode simulation,
l'interface ne comporte aucun champ de carte : on choisit un scénario correspondant aux cartes de test
publiques de Stripe (`src/lib/sim-cards.ts`).

---

## 4. Clés et configuration

- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` : lues uniquement dans `src/lib/env.ts`, jamais exposées
  au navigateur (aucune variable `NEXT_PUBLIC_*`), jamais journalisées. `/admin/settings` n'affiche
  qu'un préfixe masqué.
- Variable d'environnement serveur requise par le module : `DATABASE_URL`, `APP_URL`, `APP_SECRET`
  (≥ 16 caractères, `openssl rand -hex 32` recommandé).
- **Garde-fou** : une clé `sk_live_…` fait échouer le démarrage si `NODE_ENV != production` —
  impossible de débiter une vraie carte par accident depuis un poste de développement.
- Aucune valeur secrète n'est acceptée depuis une requête HTTP.

---

## 5. Contrôle d'accès

- Session signée HMAC-SHA256 (`APP_SECRET`), cookie `HttpOnly` + `SameSite=Lax` (+ `Secure` en production).
- `/billing`, `/billing/invoices` : utilisateur authentifié requis.
- `/admin/revenue`, `/admin/settings` : rôle `OWNER` requis — côté page, redirection ; côté API,
  `401` (non authentifié) / `403` (authentifié mais non propriétaire).
- Les routes de facturation vérifient que la ressource appartient bien à l'utilisateur connecté
  (facture, abonnement).
- Actions modifiant l'état : contrôle d'origine (`assertSameOrigin`, défense CSRF) et limitation de
  débit (`rateLimit`, fenêtre 60 s).
- Les routes `/api/sim/*` renvoient `404` dès qu'une clé Stripe est configurée : la simulation ne peut
  pas être utilisée contre un compte réel.

---

## 6. Intégrité des montants

Le montant n'est jamais lu depuis la requête. `priceCents(planCode, interval)` recalcule le prix à
partir du catalogue serveur (`src/lib/plans.ts`) au moment de créer le paiement, et l'abonnement en
base est mis à jour à partir des données reçues de Stripe (objets signés), pas de celles du client.

Le test « une tentative de forcer un paiement via le corps de la requête est sans effet » envoie
`amountCents: 1` et `status: "ACTIVE"` : le prix retenu est 5900 et le statut reste `INCOMPLETE`.

---

## 7. Virement bancaire

- La facture est créée au statut `AWAITING_BANK_TRANSFER` : **aucun accès**.
- Le client peut **déclarer** son virement : cela enregistre une information et une note, sans changer
  le statut (`declareBankTransfer`).
- La confirmation exige : rôle `OWNER`, référence exacte de la facture, et journalisation
  (qui, quand, quelle note, quel montant). Seule cette voie passe la facture à `PAID` et active
  l'abonnement.
- Un paiement `BANK_TRANSFER` est enregistré comme encaissement (comptabilité et MRR corrects).
- Optionnellement (case à cocher admin), le règlement est répliqué dans Stripe sous forme de facture
  « réglée hors ligne » (`paid_out_of_band`) — sans moyen de paiement, sans donnée bancaire.

---

## 8. Journalisation et audit

Chaque décision est tracée dans `audit_logs` : type d'acteur (`STRIPE`, `SYSTEM`, `ADMIN`, `CUSTOMER`),
action, cible, métadonnées non sensibles. Exemples : `webhook.signature_invalid`,
`webhook.duplicate_ignored`, `stripe.event.out_of_order_ignored`, `invoice.payment_failed`,
`subscription.reactivated_after_payment`, `bank_transfer.declared_by_customer`,
`bank_transfer.confirmed`, `refund.requested`.

Les paiements échoués conservent le motif Stripe (`card_declined`, `insufficient_funds`…) — jamais de
donnée de carte.

---

## 9. Limites connues / à traiter avant production

1. **Authentification de démonstration** (`src/lib/auth.ts`) : à remplacer par votre fournisseur
   d'identité (NextAuth, Clerk, Auth0, SSO). Les contrôles d'autorisation restent valables tels quels.
2. **Limitation de débit en mémoire** : suffisante pour une instance unique ; utilisez Redis ou la
   limitation de votre hébergeur en multi-instances.
3. **Migrations** : utiliser `prisma migrate deploy` en production (schéma aujourd'hui poussé via
   `db push` pour la démonstration).
4. **Supervision** : branchez une alerte sur `webhook_events.status = 'FAILED'` ; Stripe réessaie
   plusieurs jours, l'endpoint peut être rejoué sans risque d'effet double.

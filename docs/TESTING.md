# Stratégie et résultats de test

Deux niveaux complémentaires :

1. **`npm test`** — 36 tests exécutés contre une vraie base PostgreSQL (base dédiée `DATABASE_URL_TEST`),
   avec les mêmes chemins de code qu'en production (service de facturation → passerelle → événements
   signés → webhook → écriture en base).
2. **`bash scripts/smoke-http.sh`** — 27 vérifications HTTP sur un serveur démarré (`npm start` ou
   `npm run dev`), qui valident le comportement réel des routes, des cookies et des codes de statut.

Aucune carte réelle, aucun compte Stripe, aucun accès Internet n'est nécessaire : le mode simulation
reproduit les objets et événements Stripe au format exact, signés avec le même algorithme HMAC-SHA256.

---

## Résultats

```
npm test                                        → 36 tests, 36 réussis, 0 échec  (~3 s)
bash scripts/smoke-http.sh                      → 27 vérifications, 27 réussies
npm run typecheck                               → aucune erreur
npm run build                                   → compilation réussie (26 routes)
```

---

## Matrice des scénarios exigés

| Scénario demandé | Test automatisé | Ce qui est vérifié |
|---|---|---|
| Paiement réussi | `scenarios.test.ts` → « 1. Paiement réussi… » | intention `INCOMPLETE` avant paiement, `ACTIVE` après webhooks, facture `PAID`, paiement `SUCCEEDED`, accès accordé |
| Paiement refusé | → « 4. Paiement refusé… » | aucun abonnement Stripe créé, facture `OPEN`, paiement `FAILED` (`card_declined`), **aucun accès** |
| Abonnement créé | → « 1. » + « checkout.session.completed non payé » | `customer.subscription.created` traité ; une session non payée n'active rien |
| Abonnement renouvelé | → « 5. Renouvellement… » | période prolongée, 2ᵉ facture payée, 2 paiements encaissés (2 × 29 €) |
| Paiement échoué | → « 6. Paiement échoué au renouvellement… » | `PAST_DUE`, motif `card_declined`, période de grâce puis suspension automatique |
| Annulation | → « 7. Annulation en fin de période… » | `cancel_at_period_end`, accès maintenu jusqu'à l'échéance, `CANCELED` + accès coupé après |
| Changement de forfait | → « 8. Changement de forfait… » | plan et montant mis à jour, prorata sur montée en gamme, journal d'audit |
| Remboursement | → « 9. Remboursement… » | paiement `REFUNDED` (montant remboursé), facture `REFUNDED`, accès inchangé |
| Webhook invalide | → « 11. » (signature falsifiée) et « 12. » (signature expirée) | `400`, **aucune écriture**, tentative journalisée |
| Webhook répété | → « 13. Webhook répété… » | 3 rejeux → `duplicate: true`, aucun doublon de facture/paiement, chaque rejeu tracé |
| Virement bancaire | → « 10. Virement bancaire… » | facture `AWAITING_BANK_TRANSFER`, déclaration client ≠ paiement, référence erronée refusée, confirmation OWNER → `PAID` + `ACTIVE`, double confirmation impossible |
| Cas limites de sécurité | → « 2. », « 3. », « 14. », « 15. » | page de retour sans webhook, session non payée, événement hors ordre, cohérence MRR/ARR |

---

## Tests de sécurité (architecture et exécution)

| Test | Règle protégée |
|---|---|
| aucun champ de carte dans le schéma | pas de PAN / CVV / expiration en base |
| aucun code source n'enregistre de carte | recherche d'affectations de champs de carte dans tout le code |
| composants clients sans accès base/config serveur | pas de `import` de `db.ts` / `env.ts` depuis un composant client |
| seuls les modules de paiement écrivent l'état | `subscription.update/upsert/create` interdit hors `state.ts` / `bank-transfer.ts` |
| aucun composant ne peut déclarer un paiement réussi | pas de `status: "ACTIVE"` ni `payment_status: "paid"` dans l'UI |
| route de statut en lecture seule | aucun verbe d'écriture, aucun appel Prisma d'écriture |
| clés Stripe lues uniquement au centre de configuration | une seule porte d'entrée pour les secrets |
| webhook sans signature | `400 signature_missing`, rien n'est enregistré |
| webhook d'un autre environnement | `400 mode_mismatch`, rien n'est enregistré |
| corps de requête falsifié | montant et statut envoyés par le client ignorés |
| clé `sk_live_…` hors production | le démarrage échoue (garde-fou anti-débit accidentel) |

---

## Vérifications HTTP (`scripts/smoke-http.sh`)

- pages publiques (`/`, `/pricing`, `/login`, `/sim`) et sonde du webhook ;
- webhook : signature absente, signature falsifiée, corps non JSON → `400` ;
- accès protégés : `/billing` et `/admin/revenue` sans session → redirection, API → `401` ;
- parcours complet : connexion → checkout **PRO 5900 centimes** → statut `INCOMPLETE` (accès refusé) →
  paiement par carte de test → **3 webhooks signés acceptés** → statut `ACTIVE PRO` (accès accordé) ;
- règle absolue : `POST` forgé sur la route de statut → `405` ;
- idempotence : rejeu du paiement → statut inchangé ;
- séparation des rôles : un client ne peut ni consulter `/admin/revenue` (`307`) ni confirmer un virement
  (`403`).

---

## Exécuter les tests

```bash
npm test                       # base de test dédiée (DATABASE_URL_TEST), schéma synchronisé automatiquement
npm run typecheck              # TypeScript strict
bash scripts/smoke-http.sh     # après « npm run db:seed » et « npm start »
```

Le lanceur (`scripts/run-tests.ts`) synchronise le schéma sur la base de test, exécute les fichiers de
test **séquentiellement** (ils partagent la même base) et affiche un récapitulatif explicite.

---

## Reproduire les scénarios à la main (sans écrire de test)

| Objectif | Où |
|---|---|
| Paiement accepté | `/pricing` → s'abonner → carte `4242…4242` |
| Paiement refusé | `/pricing` → s'abonner → carte `4000 0000 0000 0002` |
| 3D Secure | `/pricing` → s'abonner → carte `4000 0000 0000 3220` |
| Renouvellement réussi / échoué | `/sim` → boutons sur l'abonnement concerné |
| Annulation puis reprise | `/billing` → « Annuler l'abonnement » puis « Reprendre l'abonnement » |
| Changement de forfait | `/pricing` → « Passer à … » (prorata affiché) |
| Remboursement | `/admin/revenue` → « Rembourser » sur un paiement carte |
| Webhook invalide | `curl -X POST …/api/stripe/webhook -H 'stripe-signature: t=1,v1=x' -d '{}'` → `400` |
| Webhook répété | rejouer un paiement dans `/sim` → aucun double effet |
| Virement bancaire | `/pricing` → « Payer par virement bancaire », puis `/admin/revenue` → confirmer |

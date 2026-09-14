/**
 * Cartes de test publiques de Stripe, utilisées uniquement pour choisir un SCÉNARIO
 * de paiement en mode simulation. Aucun numéro de carte réel n'est manipulé, et
 * aucune donnée de carte n'est transmise à l'application.
 *
 * Module volontairement sans dépendance serveur : importable depuis un composant client.
 */
export const SIM_TEST_CARDS = {
  success: { number: "4242 4242 4242 4242", label: "Paiement accepté" },
  declined: { number: "4000 0000 0000 0002", label: "Carte refusée (generic_decline)" },
  insufficientFunds: { number: "4000 0000 0000 9995", label: "Provision insuffisante" },
  requiresAuth: { number: "4000 0000 0000 3220", label: "Authentification 3D Secure requise" },
} as const;

export type SimScenario = keyof typeof SIM_TEST_CARDS;

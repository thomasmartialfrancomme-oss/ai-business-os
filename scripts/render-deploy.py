#!/usr/bin/env python3
"""
Déploiement automatique d'AI Business OS sur Render, via l'API Render.

Ce script crée, dans l'ordre :
  1. la base PostgreSQL (plan gratuit, région Francfort)
  2. le service web (Docker, depuis le dépôt GitHub indiqué)
  3. toutes les variables d'environnement
  4. le premier déploiement
  5. l'ajustement de APP_URL et l'arrêt du peuplement de démonstration

Il est **idempotent** : relancé, il réutilise ce qui existe déjà au lieu de le recréer.

Utilisation :
    RENDER_API_KEY=rnd_xxxxxxxx python3 scripts/render-deploy.py

Variables facultatives :
    REPO_URL      dépôt à déployer  (défaut : celui du projet)
    BRANCH        branche           (défaut : main)
    SERVICE_NAME  nom du service    (défaut : ai-business-os)
    DB_NAME       nom de la base    (défaut : ai-business-os-db)
    REGION        région Render     (défaut : frankfurt)
    PLAN          plan du service   (défaut : free)
    DB_PLAN       plan de la base   (défaut : free)
    SANS_ATTENTE  =1 pour ne pas attendre la fin du déploiement
"""

from __future__ import annotations

import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request

API = "https://api.render.com/v1"
KEY = os.environ.get("RENDER_API_KEY", "").strip()
REPO = os.environ.get("REPO_URL", "https://github.com/thomasmartialfrancomme-oss/ai-business-os")
BRANCH = os.environ.get("BRANCH", "main")
SERVICE_NAME = os.environ.get("SERVICE_NAME", "ai-business-os")
DB_NAME = os.environ.get("DB_NAME", "ai-business-os-db")
DB_USER = os.environ.get("DB_USER", "aibos")
DB_BASE = os.environ.get("DB_BASE", "aibos")
REGION = os.environ.get("REGION", "frankfurt")
PLAN = os.environ.get("PLAN", "free")
DB_PLAN = os.environ.get("DB_PLAN", "free")
PG_VERSION = os.environ.get("PG_VERSION", "16")
NO_WAIT = os.environ.get("SANS_ATTENTE") == "1"

ETAPE = 0


def log(msg: str = "") -> None:
    print(msg, flush=True)


def titre(msg: str) -> None:
    global ETAPE
    ETAPE += 1
    log("")
    log("═" * 72)
    log(f"  ÉTAPE {ETAPE} — {msg}")
    log("═" * 72)


def api(method: str, path: str, body=None, silencieux=False):
    """Appel API Render. Renvoie (données, code_http). Le code 0 signale une erreur réseau."""
    req = urllib.request.Request(API + path, method=method)
    req.add_header("Authorization", f"Bearer {KEY}")
    req.add_header("Accept", "application/json")
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=90) as resp:
            brut = resp.read().decode("utf-8")
            return (json.loads(brut) if brut.strip() else None), resp.status
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        if not silencieux:
            log(f"    ⚠ HTTP {exc.code} sur {method} {path}")
            log(f"      {detail[:400]}")
        return {"__erreur__": exc.code, "detail": detail}, exc.code
    except Exception as exc:  # réseau, DNS, délai…
        if not silencieux:
            log(f"    ⚠ Échec de connexion : {exc}")
        return {"__erreur__": 0, "detail": str(exc)}, 0


def pause(sec: int, message: str) -> None:
    for reste in range(sec, 0, -1):
        log(f"    … {message} ({reste} s)")
        time.sleep(1)


# ─────────────────────────────────────────────────────────────────────────────


def verifier_cle() -> str:
    """Valide la clé et renvoie l'identifiant de l'espace de travail (ownerId)."""
    titre("Vérification de la clé API Render")

    if not KEY:
        log("  ✗ Aucune clé fournie.")
        log("    Crée-la ici : https://dashboard.render.com/u/settings?add-api-key")
        log("    puis relance :  RENDER_API_KEY=rnd_... python3 scripts/render-deploy.py")
        sys.exit(2)

    log(f"  Clé reçue : {KEY[:6]}…{KEY[-4:]} ({len(KEY)} caractères)")

    owners, code = api("GET", "/owners?limit=20")
    if code != 200 or not isinstance(owners, list) or not owners:
        log("")
        log("  ✗ La clé API n'a pas été acceptée par Render.")
        if code == 401:
            log("    → Vérifie que tu as copié la clé ENTIÈRE (elle commence par « rnd_ »)")
            log("      et qu'elle n'a pas été révoquée.")
        elif code == 403:
            log("    → La clé n'a pas les droits nécessaires.")
        sys.exit(3)

    owner = owners[0].get("owner", {})
    log(f"  ✓ Compte : {owner.get('name', '?')} <{owner.get('email', '?')}>")
    log(f"  ✓ Espace de travail : {owner.get('id')}")
    return owner.get("id", "")


def trouver_base(owner_id: str):
    bases, code = api("GET", "/postgres?limit=50", silencieux=True)
    if code != 200 or not isinstance(bases, list):
        return None
    for item in bases:
        base = item.get("postgres", item)
        if base.get("name") == DB_NAME:
            return base
    return None


def creer_base(owner_id: str) -> dict:
    titre(f"Base de données PostgreSQL « {DB_NAME} »")

    existante = trouver_base(owner_id)
    if existante:
        log(f"  ✓ La base existe déjà ({existante.get('id')}, état : {existante.get('status')})")
        return existante

    log(f"  Création : plan={DB_PLAN}, région={REGION}, PostgreSQL {PG_VERSION}…")
    base, code = api(
        "POST",
        "/postgres",
        {
            "name": DB_NAME,
            "ownerId": owner_id,
            "plan": DB_PLAN,
            "region": REGION,
            "version": PG_VERSION,
            "databaseName": DB_BASE,
            "databaseUser": DB_USER,
        },
    )
    if code not in (200, 201):
        log("")
        log("  ✗ Impossible de créer la base.")
        log("    → Une base gratuite existe peut-être déjà sur ce compte (une seule autorisée).")
        log("    → Ou Render demande une vérification de paiement (erreur 402).")
        sys.exit(4)

    base_id = base.get("id")
    log(f"  ✓ Base créée : {base_id}")

    for _ in range(40):  # jusqu'à ~5 minutes
        infos, code = api("GET", f"/postgres/{base_id}", silencieux=True)
        etat = (infos or {}).get("status", "?")
        if etat == "available":
            log("  ✓ Base disponible")
            return infos
        pause(8, f"base en cours de création (état : {etat})")

    log("  ⚠ La base prend plus de temps que prévu — poursuite du déploiement.")
    return base


def chaine_connexion(base_id: str) -> str:
    infos, code = api("GET", f"/postgres/{base_id}/connection-info", silencieux=True)
    if code != 200 or not isinstance(infos, dict):
        log("  ✗ Impossible de lire les identifiants de la base.")
        sys.exit(5)
    interne = infos.get("internalConnectionString") or ""
    if not interne:
        log("  ✗ Chaîne de connexion interne absente.")
        sys.exit(5)
    log(f"  ✓ Connexion interne récupérée (…{interne[-24:]})")
    return interne


def variables_environnement(database_url: str, url_app: str) -> list:
    return [
        {"key": "DATABASE_URL", "value": database_url},
        {"key": "APP_SECRET", "value": secrets.token_hex(32)},
        {"key": "APP_URL", "value": url_app},
        # La version du Dockerfile actuellement sur GitHub écoute sur 3000 :
        # PORT indique à Render où router le trafic. Inutile dès que la
        # version à port dynamique sera poussée.
        {"key": "PORT", "value": "3000"},
        {"key": "NODE_ENV", "value": "production"},
        {"key": "DEMO_LOGIN", "value": "true"},
        {"key": "ALLOW_SIMULATION", "value": "auto"},
        {"key": "SEED_DEMO", "value": "true"},
        {"key": "ANNUAL_DISCOUNT_PERCENT", "value": "20"},
        {"key": "PAST_DUE_GRACE_DAYS", "value": "3"},
    ]


def trouver_service(owner_id: str):
    services, code = api("GET", "/services?limit=100", silencieux=True)
    if code != 200 or not isinstance(services, list):
        return None
    for item in services:
        svc = item.get("service", item)
        if svc.get("name") == SERVICE_NAME:
            return svc
    return None


def creer_service(owner_id: str, database_url: str) -> dict:
    titre(f"Service web « {SERVICE_NAME} » (Docker)")

    existant = trouver_service(owner_id)
    if existant:
        log(f"  ✓ Le service existe déjà : {existant.get('id')}")
        return existant

    url_prevue = f"https://{SERVICE_NAME}.onrender.com"
    log(f"  Dépôt    : {REPO} (branche {BRANCH})")
    log(f"  Runtime  : Docker → ./Dockerfile")
    log(f"  Région   : {REGION} — plan : {PLAN}")
    log(f"  URL visée: {url_prevue}")

    corps = {
        "type": "web_service",
        "name": SERVICE_NAME,
        "ownerId": owner_id,
        "repo": REPO,
        "branch": BRANCH,
        # Dépôt public : Render ne gère pas le déploiement automatique dans ce mode.
        "autoDeploy": "no",
        "envVars": variables_environnement(database_url, url_prevue),
        "serviceDetails": {
            "runtime": "docker",
            "plan": PLAN,
            "region": REGION,
            "healthCheckPath": "/api/stripe/webhook",
            "envSpecificDetails": {
                "dockerfilePath": "./Dockerfile",
                "dockerContext": ".",
            },
        },
    }

    service, code = api("POST", "/services", corps)
    if code not in (200, 201):
        log("")
        log("  ✗ Render a refusé la création du service.")
        log("    → Si le message parle de dépôt introuvable : le dépôt doit être PUBLIC.")
        log("      Rends-le public ici (Danger Zone → Change visibility) :")
        log("      https://github.com/thomasmartialfrancomme-oss/ai-business-os/settings")
        log("      …ou autorise Render à lire le dépôt (Connect GitHub dans Render).")
        sys.exit(6)

    log(f"  ✓ Service créé : {service.get('id')}")
    log(f"    Tableau de bord : {service.get('dashboardUrl', '?')}")
    return service


def declencher_deploiement(service_id: str) -> str:
    titre("Premier déploiement")
    deploiement, code = api(
        "POST", f"/services/{service_id}/deploys", {"clearCache": "clear"}
    )
    if code not in (200, 201):
        log("  ⚠ Le déclenchement a échoué — un déploiement est peut-être déjà en cours.")
        return ""
    dep_id = deploiement.get("id", "")
    log(f"  ✓ Déploiement lancé : {dep_id}")
    return dep_id


def attendre_deploiement(service_id: str) -> str:
    """Attend la fin du déploiement. Renvoie 'live', 'echec' ou 'inconnu'."""
    log("")
    log("  Compilation puis démarrage (5 à 15 minutes la première fois)…")
    finaux = {"live", "build_failed", "update_failed", "canceled", "deactivated"}
    etats_vus = []
    for _ in range(120):  # jusqu'à ~20 minutes
        items, code = api("GET", f"/services/{service_id}/deploys?limit=1", silencieux=True)
        if code == 200 and isinstance(items, list) and items:
            dep = items[0].get("deploy", items[0])
            etat = dep.get("status", "?")
            if not etats_vus or etats_vus[-1] != etat:
                log(f"    → état : {etat}")
                etats_vus.append(etat)
            if etat in finaux:
                return "live" if etat == "live" else "echec"
        pause(10, "déploiement en cours")
    return "inconnu"


def url_service(service_id: str) -> str:
    service, code = api("GET", f"/services/{service_id}", silencieux=True)
    if code != 200 or not isinstance(service, dict):
        return ""
    details = service.get("serviceDetails", {}) or {}
    return details.get("url", "") or ""


def tester_site(url: str) -> bool:
    cible = url.rstrip("/") + "/api/stripe/webhook"
    log(f"  Test de {cible} …")
    for essai in range(1, 11):
        try:
            with urllib.request.urlopen(cible, timeout=45) as resp:
                if resp.status == 200:
                    log(f"  ✓ Le site répond (HTTP {resp.status}) — essai {essai}")
                    return True
                log(f"    essai {essai} : HTTP {resp.status}")
        except urllib.error.HTTPError as exc:
            # 405 (mauvaise méthode) = le serveur est bien vivant
            if exc.code in (400, 401, 403, 405, 422):
                log(f"  ✓ Le site répond (HTTP {exc.code}) — essai {essai}")
                return True
            log(f"    essai {essai} : HTTP {exc.code}")
        except Exception as exc:
            log(f"    essai {essai} : pas encore prêt ({type(exc).__name__})")
        time.sleep(20)
    return False


def finaliser(service_id: str, url_reelle: str) -> None:
    """Met APP_URL à jour et coupe le peuplement de démonstration."""
    titre("Réglages finaux")

    actuelles, code = api("GET", f"/services/{service_id}/env-vars", silencieux=True)
    liste = []
    if code == 200 and isinstance(actuelles, list):
        for item in actuelles:
            var = item.get("envVar", item)
            if isinstance(var, dict) and var.get("key"):
                liste.append({"key": var["key"], "value": var.get("value", "")})
    if not liste:
        log("  ⚠ Variables illisibles — réglages finaux ignorés.")
        return

    modifs = []
    for var in liste:
        if var["key"] == "APP_URL" and url_reelle and var["value"] != url_reelle:
            log(f"  APP_URL : {var['value']} → {url_reelle}")
            var["value"] = url_reelle
            modifs.append("APP_URL")
        if var["key"] == "SEED_DEMO" and var["value"] != "false":
            log("  SEED_DEMO : true → false (plus aucun effacement de données au redémarrage)")
            var["value"] = "false"
            modifs.append("SEED_DEMO")

    if not modifs:
        log("  ✓ Rien à corriger")
        return

    _, code = api("PUT", f"/services/{service_id}/env-vars", liste)
    if code in (200, 201):
        log(f"  ✓ Réglages appliqués : {', '.join(modifs)}")
        log("  Le déploiement correspondant démarre automatiquement.")
    else:
        log("  ⚠ L'application des réglages a échoué — fais-les à la main dans")
        log(f"    https://dashboard.render.com/web/{service_id}/env")


# ─────────────────────────────────────────────────────────────────────────────


def main() -> None:
    log("")
    log("╔" + "═" * 70 + "╗")
    log("║" + "  AI BUSINESS OS — déploiement automatique sur Render".center(70) + "║")
    log("╚" + "═" * 70 + "╝")

    owner_id = verifier_cle()
    base = creer_base(owner_id)
    database_url = chaine_connexion(base["id"])
    service = creer_service(owner_id, database_url)
    declencher_deploiement(service["id"])

    etat = "inconnu" if NO_WAIT else attendre_deploiement(service["id"])
    url = url_service(service["id"]) or f"https://{SERVICE_NAME}.onrender.com"

    titre("RÉSULTAT")
    log(f"  État du déploiement : {etat}")
    log(f"  Adresse du site     : {url}")
    log(f"  Tableau de bord     : https://dashboard.render.com/web/{service['id']}")
    log(f"  Base de données     : https://dashboard.render.com/psql/{base['id']}")
    log("")

    if etat == "live":
        vivant = tester_site(url)
        if vivant:
            finaliser(service["id"], url)
            log("")
            log("  ✓ MISE EN LIGNE RÉUSSIE")
            log("")
            log("  Pages à visiter :")
            log(f"    {url}            page d'accueil")
            log(f"    {url}/pricing    forfaits (29 / 59 / 99 €)")
            log(f"    {url}/login      connexion de démonstration")
            log(f"    {url}/billing    espace facturation du client")
            log(f"    {url}/admin/revenue  tableau de bord du propriétaire")
        else:
            log("  ⚠ Le service est déployé mais ne répond pas encore.")
            log("    Consulte les journaux : onglet « Logs » du tableau de bord.")
            log("    (Un service gratuit s'endort après 15 min ; le réveil prend ~1 min.)")
    elif etat == "echec":
        log("  ✗ Le déploiement a échoué côté Render.")
        log("    Ouvre l'onglet « Logs » et copie-moi le message d'erreur :")
        log(f"    https://dashboard.render.com/web/{service['id']}")
    else:
        log("  ℹ Déploiement encore en cours — relance ce script pour connaître l'avancement,")
        log("    ou suis-le en direct sur le tableau de bord ci-dessus.")

    log("")
    log("  Rappel des réglages à faire ensuite (Stripe) :")
    log("    • clé Stripe        → https://dashboard.stripe.com/test/apikeys")
    log("    • webhook à créer   → " + (url.rstrip("/") + "/api/stripe/webhook"))
    log("    • IBAN de versement → https://dashboard.stripe.com/settings/payouts")
    log("")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("\n  Interrompu. Relance le script : il reprend là où il s'était arrêté.")
        sys.exit(130)

#!/usr/bin/env python3
"""
Ticket Alert — Surveillance multi-événements avec notification Telegram + macOS.

Lit les événements depuis events.json (géré via l'interface web server.py).
Surveille toutes les pages actives et alerte dès qu'une billetterie ouvre.

Usage:
    python3 monitor.py
"""

import json
import os
import requests
from bs4 import BeautifulSoup
import subprocess
import webbrowser
import time
import sys
from datetime import datetime

# ═══════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
EVENTS_FILE = os.path.join(SCRIPT_DIR, "data.json")

# Charge .env si present
_env_path = os.path.join(SCRIPT_DIR, ".env")
if os.path.exists(_env_path):
    with open(_env_path) as _f:
        for _line in _f:
            _line = _line.strip()
            if _line and not _line.startswith("#") and "=" in _line:
                _k, _v = _line.split("=", 1)
                os.environ.setdefault(_k.strip(), _v.strip())

TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")

# Intervalle entre chaque vérification (en secondes)
CHECK_INTERVAL = 5

# Plateformes de billetterie connues
TICKET_PLATFORMS = [
    "ticketmaster.fr", "ticketmaster.com", "fnacspectacles",
    "seetickets", "digitick", "eventbrite", "weezevent",
    "shotgun", "dice.fm", "festicket", "starstruck",
    "francebillet", "carrefourspectacles",
]

# Liens de navigation permanents (présents sur toutes les pages du site)
PERMANENT_LINK_PATTERNS = [
    "/fr/panier", "/fr/identification", "/billetterie/",
    "/billets-securite/", "racing92.fr", "/groupes-et-ce/",
    "-offre-vip/",
]

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.5",
    "Accept-Encoding": "gzip, deflate",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
}


# ═══════════════════════════════════════════════════════════
# ÉVÉNEMENTS
# ═══════════════════════════════════════════════════════════

def load_events():
    """Charge les événements actifs depuis events.json."""
    if not os.path.exists(EVENTS_FILE):
        return []
    with open(EVENTS_FILE, "r", encoding="utf-8") as f:
        all_events = json.load(f)
    return [ev for ev in all_events if ev.get("active", True)]


# ═══════════════════════════════════════════════════════════
# NOTIFICATIONS
# ═══════════════════════════════════════════════════════════

def send_telegram(text):
    """Envoie un message Telegram."""
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
        payload = {"chat_id": TELEGRAM_CHAT_ID, "text": text}
        requests.post(url, json=payload, timeout=5)
    except Exception:
        pass


def notify_macos(title, message):
    """Envoie une notification macOS native."""
    subprocess.run([
        "osascript", "-e",
        f'display notification "{message}" with title "{title}" sound name "Glass"'
    ])


def play_alarm():
    """Joue un son d'alarme."""
    sounds = [
        "/System/Library/Sounds/Glass.aiff",
        "/System/Library/Sounds/Hero.aiff",
        "/System/Library/Sounds/Ping.aiff",
        "/System/Library/Sounds/Sosumi.aiff",
    ]
    for sound in sounds:
        subprocess.run(["afplay", sound])
        time.sleep(0.2)


# ═══════════════════════════════════════════════════════════
# DÉTECTION
# ═══════════════════════════════════════════════════════════

def check_event(event):
    """
    Vérifie la page d'un événement.
    Retourne: (status, detail, ticket_url)
    """
    event_url = event.get("url", "")
    closed_marker = event.get("closed_marker", "")

    try:
        response = requests.get(event_url, headers=HEADERS, timeout=10)
        response.raise_for_status()

        soup = BeautifulSoup(response.text, "html.parser")
        page_text = soup.get_text(separator=" ").lower()

        # ── CHECK 1 : Nouveau lien de billetterie ──
        for link in soup.find_all("a", href=True):
            href = link.get("href", "").lower()
            link_text = link.get_text(strip=True).lower()

            # Ignorer les liens de navigation permanents
            if any(perm in href for perm in PERMANENT_LINK_PATTERNS):
                continue

            # Lien vers une plateforme de billetterie
            for platform in TICKET_PLATFORMS:
                if platform in href:
                    return "OPEN", f"Lien billetterie : {platform}", link["href"]

            # Lien d'achat direct
            if any(kw in href for kw in ["panier", "cart", "checkout", "purchase", "manifestation", "booking", "order"]):
                return "OPEN", f"Lien d'achat : {href}", link["href"]

            # Bouton "acheter" / "reserver"
            if any(kw in link_text for kw in [
                "acheter", "achetez vos billets", "achetez vos places",
                "prendre mes places", "accéder à la billetterie",
                "reserver", "réserver",
            ]):
                if not any(skip in href for skip in ["groupes", "vip", "racing92"]):
                    return "OPEN", f"Bouton d'achat : '{link_text}'", link["href"]

            # Lien vers une billetterie specifique a un evenement
            if "tickets." in href and ("/manifestation/" in href or "/event/" in href or "/show/" in href):
                return "OPEN", f"Lien billetterie directe : {href}", link["href"]

        # ── CHECK 2 : Marqueur de fermeture ──
        if closed_marker:
            if closed_marker.lower() in page_text:
                return "CLOSED", f"'{closed_marker}' toujours present", None
            else:
                return "CHANGED", f"'{closed_marker}' a disparu !", None

        # Pas de marqueur configuré → on ne peut vérifier que les liens
        return "CLOSED", "Aucun lien de billetterie detecte", None

    except requests.exceptions.HTTPError as e:
        return "ERROR", f"HTTP {e}", None
    except requests.exceptions.ConnectionError:
        return "ERROR", "Connexion impossible", None
    except requests.exceptions.Timeout:
        return "ERROR", "Timeout (site surcharge ?)", None
    except Exception as e:
        return "ERROR", str(e), None


# ═══════════════════════════════════════════════════════════
# ALERTE
# ═══════════════════════════════════════════════════════════

def trigger_alert(event, detail, ticket_url=None):
    """Déclenche l'alerte pour un événement."""
    name = event.get("name", "?")
    venue = event.get("venue", "")
    url = ticket_url or event.get("url", "")

    print(f"\n{'!' * 60}")
    print(f"  BILLETTERIE OUVERTE — {name.upper()}")
    print(f"  {detail}")
    if ticket_url:
        print(f"  URL : {ticket_url}")
    print(f"{'!' * 60}\n")

    # Ouvre le navigateur
    if url and url.startswith("http"):
        webbrowser.open(url)

    # Notification macOS
    notify_macos("BILLETTERIE OUVERTE !", f"{name} — Fonce prendre tes places !")

    # Telegram
    msg = (
        f"🚨🚨🚨 BILLETTERIE OUVERTE !!! 🚨🚨🚨\n\n"
        f"🎤 {name}"
        f"{' — ' + venue if venue else ''}\n\n"
        f"👉 {url}\n\n"
        f"FONCE PRENDRE TES PLACES MAINTENANT !"
    )
    send_telegram(msg)

    # Alarme sonore
    print("Alarme en boucle — Ctrl+C pour arreter")
    try:
        while True:
            play_alarm()
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nAlarme arretee.")


# ═══════════════════════════════════════════════════════════
# BOUCLE PRINCIPALE
# ═══════════════════════════════════════════════════════════

def run_monitor():
    events = load_events()

    if not events:
        print("Aucun evenement actif dans events.json")
        print("Lance le serveur web : python3 server.py")
        print("Puis ajoute des evenements sur http://localhost:5555")
        sys.exit(1)

    print("=" * 60)
    print("  TICKET ALERT — Surveillance multi-evenements")
    print(f"  {len(events)} evenement(s) actif(s)")
    print(f"  Verification toutes les {CHECK_INTERVAL}s")
    print("=" * 60)

    for ev in events:
        print(f"  • {ev['name']} — {ev.get('venue', '?')}")
    print()

    # Test initial de chaque événement
    print("Test de connexion...")
    for ev in events:
        status, detail, url = check_event(ev)
        tag = ev["name"][:25]
        if status == "OPEN" or status == "CHANGED":
            print(f"  [{tag}] ALERTE : {detail}")
            trigger_alert(ev, detail, url)
            sys.exit(0)
        elif status == "ERROR":
            print(f"  [{tag}] ERREUR : {detail}")
        else:
            print(f"  [{tag}] OK — {detail}")

    print()

    # Notification de démarrage
    names = ", ".join(ev["name"] for ev in events)
    notify_macos("Ticket Alert actif", f"Surveillance de {len(events)} evenement(s)")
    send_telegram(f"🔍 Ticket Alert demarre — {len(events)} evenement(s) :\n{names}")

    print("Surveillance en cours... (Ctrl+C pour arreter)")
    print("-" * 60)

    check_count = 0
    error_counts = {}  # event_id -> consecutive errors

    while True:
        # Recharger les événements à chaque cycle (ajouts/suppressions en temps réel)
        events = load_events()
        check_count += 1
        now = datetime.now().strftime("%H:%M:%S")

        for ev in events:
            eid = ev.get("id", ev["name"])
            tag = ev["name"][:25]

            status, detail, ticket_url = check_event(ev)

            if status == "OPEN" or status == "CHANGED":
                trigger_alert(ev, detail, ticket_url)
                # Ne pas quitter — continuer à surveiller les autres
                # Désactiver cet événement
                continue

            elif status == "CLOSED":
                error_counts[eid] = 0
                print(f"[{now}] #{check_count:>4} [{tag}] {detail}")

            elif status == "ERROR":
                error_counts[eid] = error_counts.get(eid, 0) + 1
                print(f"[{now}] #{check_count:>4} [{tag}] ERREUR ({error_counts[eid]}x) : {detail}")

                if error_counts[eid] >= 5:
                    print(f"[{now}]   -> Site surcharge — ouverture navigateur")
                    notify_macos("Site surcharge !", f"{ev['name']} — ouvre le site manuellement !")
                    send_telegram(f"⚠️ Site surcharge : {ev['name']}\n👉 {ev.get('url', '')}")
                    webbrowser.open(ev.get("url", ""))
                    error_counts[eid] = 0

        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    try:
        run_monitor()
    except KeyboardInterrupt:
        print("\n\nSurveillance arretee.")
        sys.exit(0)

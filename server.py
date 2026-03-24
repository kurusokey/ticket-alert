#!/usr/bin/env python3
"""
Ticket Alert — Serveur web + surveillance intégrée.

Usage:
    python3 server.py
    → http://localhost:5555
"""

import json
import os
import threading
import time
from collections import deque
from datetime import datetime
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse

import requests as http_requests
from bs4 import BeautifulSoup
import subprocess
import webbrowser

PORT = 5555
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

# Surveillance
CHECK_INTERVAL = 5

TICKET_PLATFORMS = [
    "ticketmaster.fr", "ticketmaster.com", "fnacspectacles",
    "seetickets", "digitick", "eventbrite", "weezevent",
    "shotgun", "dice.fm", "festicket", "starstruck",
    "francebillet", "carrefourspectacles",
]

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
# ÉTAT GLOBAL DU MONITOR
# ═══════════════════════════════════════════════════════════

monitor_state = {
    "running": False,
    "thread": None,
    "check_count": 0,
    "started_at": None,
    "logs": deque(maxlen=200),      # dernières 200 lignes de log
    "alerts": [],                    # événements alertés
}


# ═══════════════════════════════════════════════════════════
# DONNÉES
# ═══════════════════════════════════════════════════════════

def load_events():
    if not os.path.exists(EVENTS_FILE):
        return []
    with open(EVENTS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_events(events):
    with open(EVENTS_FILE, "w", encoding="utf-8") as f:
        json.dump(events, f, ensure_ascii=False, indent=2)


# ═══════════════════════════════════════════════════════════
# NOTIFICATIONS
# ═══════════════════════════════════════════════════════════

def send_telegram(text):
    try:
        url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
        http_requests.post(url, json={"chat_id": TELEGRAM_CHAT_ID, "text": text}, timeout=5)
    except Exception:
        pass


def notify_macos(title, message):
    try:
        subprocess.run([
            "osascript", "-e",
            f'display notification "{message}" with title "{title}" sound name "Glass"'
        ])
    except Exception:
        pass


def play_alarm():
    sounds = [
        "/System/Library/Sounds/Glass.aiff",
        "/System/Library/Sounds/Hero.aiff",
        "/System/Library/Sounds/Ping.aiff",
        "/System/Library/Sounds/Sosumi.aiff",
    ]
    for sound in sounds:
        try:
            subprocess.run(["afplay", sound])
            time.sleep(0.2)
        except Exception:
            pass


def add_log(message, level="info"):
    now = datetime.now().strftime("%H:%M:%S")
    entry = {"time": now, "message": message, "level": level}
    monitor_state["logs"].append(entry)


# ═══════════════════════════════════════════════════════════
# DÉTECTION
# ═══════════════════════════════════════════════════════════

def check_event(event):
    event_url = event.get("url", "")
    closed_marker = event.get("closed_marker", "")

    try:
        response = http_requests.get(event_url, headers=HEADERS, timeout=10)
        response.raise_for_status()

        soup = BeautifulSoup(response.text, "html.parser")
        page_text = soup.get_text(separator=" ").lower()

        for link in soup.find_all("a", href=True):
            href = link.get("href", "").lower()
            link_text = link.get_text(strip=True).lower()

            if any(perm in href for perm in PERMANENT_LINK_PATTERNS):
                continue

            for platform in TICKET_PLATFORMS:
                if platform in href:
                    return "OPEN", f"Lien billetterie : {platform}", link["href"]

            if any(kw in href for kw in ["panier", "cart", "checkout", "purchase"]):
                return "OPEN", f"Lien d'achat : {href}", link["href"]

            if any(kw in link_text for kw in [
                "acheter", "achetez vos billets", "achetez vos places",
                "prendre mes places", "accéder à la billetterie"
            ]):
                return "OPEN", f"Bouton d'achat : '{link_text}'", link["href"]

        if closed_marker:
            if closed_marker.lower() in page_text:
                return "CLOSED", f"'{closed_marker}' toujours present", None
            else:
                return "CHANGED", f"'{closed_marker}' a disparu !", None

        return "CLOSED", "Aucun lien de billetterie detecte", None

    except http_requests.exceptions.Timeout:
        return "ERROR", "Timeout (site surcharge ?)", None
    except http_requests.exceptions.ConnectionError:
        return "ERROR", "Connexion impossible", None
    except Exception as e:
        return "ERROR", str(e)[:100], None


# ═══════════════════════════════════════════════════════════
# ALERTE
# ═══════════════════════════════════════════════════════════

def trigger_alert(event, detail, ticket_url=None):
    name = event.get("name", "?")
    venue = event.get("venue", "")
    url = ticket_url or event.get("url", "")

    add_log(f"🚨 BILLETTERIE OUVERTE — {name} — {detail}", "alert")

    monitor_state["alerts"].append({
        "time": datetime.now().strftime("%H:%M:%S"),
        "event": name,
        "detail": detail,
        "url": url,
    })

    # Ouvre le navigateur
    if url and url.startswith("http"):
        webbrowser.open(url)

    # macOS
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

    # Alarme sonore (3 fois, pas en boucle infinie car on est dans un thread)
    for _ in range(3):
        play_alarm()
        time.sleep(0.5)


# ═══════════════════════════════════════════════════════════
# BOUCLE DE SURVEILLANCE (thread)
# ═══════════════════════════════════════════════════════════

def monitor_loop():
    add_log("Surveillance demarree", "success")

    names = ", ".join(ev["name"] for ev in load_events() if ev.get("active"))
    send_telegram(f"🔍 Ticket Alert demarre\n{names}")

    error_counts = {}

    while monitor_state["running"]:
        events = [ev for ev in load_events() if ev.get("active")]
        monitor_state["check_count"] += 1
        count = monitor_state["check_count"]

        for ev in events:
            if not monitor_state["running"]:
                break

            eid = ev.get("id", ev["name"])
            tag = ev["name"][:30]

            status, detail, ticket_url = check_event(ev)

            if status in ("OPEN", "CHANGED"):
                trigger_alert(ev, detail, ticket_url)

            elif status == "CLOSED":
                error_counts[eid] = 0
                add_log(f"#{count} [{tag}] {detail}")

            elif status == "ERROR":
                error_counts[eid] = error_counts.get(eid, 0) + 1
                add_log(f"#{count} [{tag}] ERREUR ({error_counts[eid]}x) : {detail}", "error")

                if error_counts[eid] >= 5:
                    add_log(f"[{tag}] Site surcharge — alerte envoyee", "error")
                    notify_macos("Site surcharge !", f"{ev['name']} — ouvre le site !")
                    send_telegram(f"⚠️ Site surcharge : {ev['name']}\n👉 {ev.get('url', '')}")
                    webbrowser.open(ev.get("url", ""))
                    error_counts[eid] = 0

        time.sleep(CHECK_INTERVAL)

    add_log("Surveillance arretee")
    send_telegram("⏹ Ticket Alert arrete")


def start_monitor():
    if monitor_state["running"]:
        return False
    monitor_state["running"] = True
    monitor_state["check_count"] = 0
    monitor_state["started_at"] = datetime.now().strftime("%H:%M:%S")
    monitor_state["alerts"] = []
    monitor_state["logs"].clear()
    t = threading.Thread(target=monitor_loop, daemon=True)
    monitor_state["thread"] = t
    t.start()
    return True


def stop_monitor():
    if not monitor_state["running"]:
        return False
    monitor_state["running"] = False
    return True


# ═══════════════════════════════════════════════════════════
# SERVEUR HTTP
# ═══════════════════════════════════════════════════════════

class Handler(SimpleHTTPRequestHandler):

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path in ("/", ""):
            self.path = "/index.html"
            return SimpleHTTPRequestHandler.do_GET(self)

        if parsed.path == "/api/events":
            self._json_response(load_events())
            return

        if parsed.path == "/api/monitor/status":
            self._json_response({
                "running": monitor_state["running"],
                "check_count": monitor_state["check_count"],
                "started_at": monitor_state["started_at"],
                "alerts": monitor_state["alerts"],
                "logs": list(monitor_state["logs"]),
            })
            return

        return SimpleHTTPRequestHandler.do_GET(self)

    def do_POST(self):
        parsed = urlparse(self.path)

        if parsed.path in ("/api/events", "/api/events/create"):
            body = self._read_body()
            events = load_events()
            events.append(body)
            save_events(events)
            self._json_response({"ok": True})
            return

        if parsed.path == "/api/events/update":
            body = self._read_body()
            events = load_events()
            updated = False
            for i, ev in enumerate(events):
                if ev["id"] == body["id"]:
                    events[i] = body
                    updated = True
                    break
            if not updated:
                events.append(body)
            save_events(events)
            self._json_response({"ok": True})
            return

        if parsed.path == "/api/events/remove":
            body = self._read_body()
            event_id = body.get("id", "")
            events = [ev for ev in load_events() if ev["id"] != event_id]
            save_events(events)
            self._json_response({"ok": True})
            return

        if parsed.path == "/api/events/toggle":
            body = self._read_body()
            event_id = body.get("id", "")
            events = load_events()
            for ev in events:
                if ev["id"] == event_id:
                    ev["active"] = not ev.get("active", True)
                    break
            save_events(events)
            self._json_response({"ok": True})
            return

        if parsed.path == "/api/monitor/start":
            ok = start_monitor()
            self._json_response({"ok": ok, "message": "Demarree" if ok else "Deja en cours"})
            return

        if parsed.path == "/api/monitor/stop":
            ok = stop_monitor()
            self._json_response({"ok": ok, "message": "Arretee" if ok else "Pas en cours"})
            return

        self._json_response({"error": "Not found"}, 404)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def _json_response(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        if "/api/" in str(args[0]):
            print(f"  [{self.command}] {args[0]}")


if __name__ == "__main__":
    os.chdir(SCRIPT_DIR)
    server = HTTPServer(("localhost", PORT), Handler)
    print(f"Ticket Alert")
    print(f"http://localhost:{PORT}")
    print(f"Ctrl+C pour arreter")
    print()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        stop_monitor()
        print("\nServeur arrete.")

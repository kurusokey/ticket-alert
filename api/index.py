"""
Vercel Serverless API — Ticket Alert
Handles all /api/* routes via vercel.json rewrites.
"""

from http.server import BaseHTTPRequestHandler
from datetime import datetime
from urllib.parse import urlparse
import json
import os
import re
import urllib.request

import requests as http_req
from bs4 import BeautifulSoup

# ── Config ──

TG_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TG_CHAT = os.environ.get("TELEGRAM_CHAT_ID", "")
KV_URL = os.environ.get("KV_REST_API_URL", "")
KV_TOKEN = os.environ.get("KV_REST_API_TOKEN", "")

TICKET_PLATFORMS = [
    "ticketmaster.fr", "ticketmaster.com", "fnacspectacles",
    "seetickets", "digitick", "eventbrite", "weezevent",
    "shotgun", "dice.fm", "festicket", "francebillet",
]

PERMANENT_LINK_PATTERNS = [
    "/fr/panier", "/fr/identification", "/billetterie/",
    "/billets-securite/", "racing92.fr", "/groupes-et-ce/",
    "-offre-vip/",
]

FETCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Cache-Control": "no-cache",
}


# ── KV Storage (Vercel KV / Upstash Redis) ──

def kv_get(key):
    if not KV_URL:
        return None
    try:
        req = urllib.request.Request(
            f"{KV_URL}/get/{key}",
            headers={"Authorization": f"Bearer {KV_TOKEN}"}
        )
        with urllib.request.urlopen(req, timeout=5) as res:
            data = json.loads(res.read())
            result = data.get("result")
            return json.loads(result) if result else None
    except Exception:
        return None


def kv_set(key, value):
    if not KV_URL:
        return
    try:
        body = json.dumps(["SET", key, json.dumps(value, ensure_ascii=False)]).encode()
        req = urllib.request.Request(
            KV_URL,
            data=body,
            headers={
                "Authorization": f"Bearer {KV_TOKEN}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass


def get_events():
    return kv_get("ticket_alert:events") or []


def save_events(events):
    kv_set("ticket_alert:events", events)


def get_status():
    return kv_get("ticket_alert:status") or {
        "running": False,
        "check_count": 0,
        "started_at": None,
        "logs": [],
        "alerts": [],
    }


def save_status(status):
    kv_set("ticket_alert:status", status)


# ── Telegram ──

def send_telegram(text):
    if not TG_TOKEN:
        return
    try:
        body = json.dumps({"chat_id": TG_CHAT, "text": text}).encode()
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass


# ── Detection ──

def check_event(event):
    event_url = event.get("url", "")
    closed_marker = event.get("closed_marker", "")

    try:
        response = http_req.get(event_url, headers=FETCH_HEADERS, timeout=8)
        response.raise_for_status()
        soup = BeautifulSoup(response.text, "html.parser")
        page_text = soup.get_text(separator=" ").lower()

        for link in soup.find_all("a", href=True):
            href = link.get("href", "").lower()
            link_text = link.get_text(strip=True).lower()

            if any(p in href for p in PERMANENT_LINK_PATTERNS):
                continue

            for platform in TICKET_PLATFORMS:
                if platform in href:
                    return "OPEN", f"Lien billetterie : {platform}", link["href"]

            if any(kw in href for kw in ["panier", "cart", "checkout", "purchase"]):
                return "OPEN", f"Lien d'achat : {href}", link["href"]

            if any(kw in link_text for kw in [
                "acheter", "achetez vos billets", "achetez vos places",
                "prendre mes places",
            ]):
                return "OPEN", f"Bouton d'achat : '{link_text}'", link["href"]

        if closed_marker:
            if closed_marker.lower() in page_text:
                return "CLOSED", f"'{closed_marker}' present", None
            else:
                return "CHANGED", f"'{closed_marker}' a disparu !", None

        return "CLOSED", "Pas de lien billetterie", None

    except Exception as e:
        return "ERROR", str(e)[:80], None


# ── Cron handler ──

def handle_cron():
    status = get_status()
    if not status.get("running"):
        return {"skipped": True, "reason": "Monitor not running"}

    events = [ev for ev in get_events() if ev.get("active")]
    if not events:
        return {"skipped": True, "reason": "No active events"}

    status["check_count"] = status.get("check_count", 0) + 1
    logs = status.get("logs", [])
    alerts = status.get("alerts", [])
    now = datetime.now().strftime("%H:%M:%S")

    for ev in events:
        tag = ev.get("name", "?")[:25]
        st, detail, ticket_url = check_event(ev)

        if st in ("OPEN", "CHANGED"):
            name = ev.get("name", "?")
            venue = ev.get("venue", "")
            url = ticket_url or ev.get("url", "")
            alerts.append({"time": now, "event": name, "detail": detail, "url": url})
            logs.append({"time": now, "message": f"🚨 {name} — {detail}", "level": "alert"})

            msg = f"🚨🚨🚨 BILLETTERIE OUVERTE !!!\n\n🎤 {name}"
            if venue:
                msg += f" — {venue}"
            msg += f"\n\n👉 {url}\n\nFONCE PRENDRE TES PLACES !"
            send_telegram(msg)

        elif st == "ERROR":
            logs.append({"time": now, "message": f"[{tag}] ERREUR: {detail}", "level": "error"})
        else:
            logs.append({"time": now, "message": f"[{tag}] {detail}", "level": "info"})

    status["logs"] = logs[-100:]
    status["alerts"] = alerts
    save_status(status)
    return {"ok": True, "checked": len(events)}


# ── HTTP Handler ──

class handler(BaseHTTPRequestHandler):

    def do_GET(self):
        path = urlparse(self.path).path.rstrip("/")

        if path in ("/api", "/api/"):
            self._json({"service": "Ticket Alert", "status": "ok"})

        elif path == "/api/events":
            self._json(get_events())

        elif path == "/api/monitor/status":
            self._json(get_status())

        elif path == "/api/cron":
            auth = self.headers.get("Authorization", "")
            cron_secret = os.environ.get("CRON_SECRET", "")
            if cron_secret and auth != f"Bearer {cron_secret}":
                self._json({"error": "Unauthorized"}, 401)
                return
            result = handle_cron()
            self._json(result)

        else:
            self._json({"error": "Not found"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path.rstrip("/")
        body = self._read_body()

        if path == "/api/events":
            events = get_events()
            events.append(body)
            save_events(events)
            self._json({"ok": True})

        elif path == "/api/monitor/start":
            status = get_status()
            if status.get("running"):
                self._json({"ok": False, "message": "Deja en cours"})
                return
            status["running"] = True
            status["check_count"] = 0
            status["started_at"] = datetime.now().strftime("%H:%M:%S")
            status["logs"] = []
            status["alerts"] = []
            save_status(status)
            names = ", ".join(ev["name"] for ev in get_events() if ev.get("active"))
            send_telegram(f"🔍 Ticket Alert demarre\n{names}")
            self._json({"ok": True, "message": "Demarree"})

        elif path == "/api/monitor/stop":
            status = get_status()
            status["running"] = False
            save_status(status)
            send_telegram("⏹ Ticket Alert arrete")
            self._json({"ok": True, "message": "Arretee"})

        elif re.match(r"/api/events/[^/]+/toggle$", path):
            event_id = path.split("/")[3]
            events = get_events()
            for ev in events:
                if ev["id"] == event_id:
                    ev["active"] = not ev.get("active", True)
            save_events(events)
            self._json({"ok": True})

        else:
            self._json({"error": "Not found"}, 404)

    def do_PUT(self):
        path = urlparse(self.path).path.rstrip("/")

        if path == "/api/events":
            body = self._read_body()
            events = get_events()
            updated = False
            for i, ev in enumerate(events):
                if ev["id"] == body["id"]:
                    events[i] = body
                    updated = True
                    break
            if not updated:
                events.append(body)
            save_events(events)
            self._json({"ok": True})
        else:
            self._json({"error": "Not found"}, 404)

    def do_DELETE(self):
        path = urlparse(self.path).path.rstrip("/")
        match = re.match(r"/api/events/([^/]+)$", path)

        if match:
            event_id = match.group(1)
            events = [ev for ev in get_events() if ev["id"] != event_id]
            save_events(events)
            self._json({"ok": True})
        else:
            self._json({"error": "Not found"}, 404)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length)) if length else {}

    def _json(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass

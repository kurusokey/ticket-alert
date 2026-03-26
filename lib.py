"""Shared library for Vercel API functions."""

import json
import os
import urllib.request
from datetime import datetime

import requests as http_req
from bs4 import BeautifulSoup

# ── Config ──

TG_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TG_CHAT = os.environ.get("TELEGRAM_CHAT_ID", "")
KV_URL = os.environ.get("KV_REST_API_URL", "")
KV_TOKEN = os.environ.get("KV_REST_API_TOKEN", "")

_EVENTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data.json")

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

# ── Cache global (persiste tant que l'instance est warm) ──

_cache = {"events": None, "status": None}


# ── KV ──

def _kv_get(key):
    if not KV_URL:
        return None
    try:
        req = urllib.request.Request(
            f"{KV_URL}/get/{key}",
            headers={"Authorization": f"Bearer {KV_TOKEN}"},
        )
        with urllib.request.urlopen(req, timeout=5) as res:
            data = json.loads(res.read())
            result = data.get("result")
            return json.loads(result) if result else None
    except Exception:
        return None


def _kv_set(key, value):
    if not KV_URL:
        return
    try:
        body = json.dumps(["SET", key, json.dumps(value, ensure_ascii=False)]).encode()
        req = urllib.request.Request(
            KV_URL,
            data=body,
            headers={"Authorization": f"Bearer {KV_TOKEN}", "Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass


# ── Storage ──

def get_events():
    if KV_URL:
        data = _kv_get("ticket_alert:events")
        if data is not None:
            _cache["events"] = data
            return data
    if _cache["events"] is not None:
        return list(_cache["events"])
    try:
        with open(_EVENTS_FILE, encoding="utf-8") as f:
            _cache["events"] = json.load(f)
            return list(_cache["events"])
    except Exception:
        return []


def save_events(events):
    _cache["events"] = events
    _kv_set("ticket_alert:events", events)


def get_status():
    if KV_URL:
        data = _kv_get("ticket_alert:status")
        if data is not None:
            _cache["status"] = data
            return data
    if _cache["status"] is not None:
        return dict(_cache["status"])
    return {"running": False, "check_count": 0, "started_at": None, "logs": [], "alerts": []}


def save_status(status):
    _cache["status"] = status
    _kv_set("ticket_alert:status", status)


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
            if any(kw in href for kw in ["panier", "cart", "checkout", "purchase", "manifestation", "booking", "order"]):
                return "OPEN", f"Lien d'achat : {href}", link["href"]
            if any(kw in link_text for kw in [
                "acheter", "achetez vos billets", "achetez vos places",
                "prendre mes places", "reserver", "réserver",
            ]):
                # Exclure les liens groupes/VIP/generiques deja presents
                if not any(skip in href for skip in ["groupes", "vip", "racing92"]):
                    return "OPEN", f"Bouton d'achat : '{link_text}'", link["href"]
            # Lien vers une billetterie specifique a un evenement
            if "tickets." in href and ("/manifestation/" in href or "/event/" in href or "/show/" in href):
                return "OPEN", f"Lien billetterie directe : {href}", link["href"]

        if closed_marker:
            if closed_marker.lower() in page_text:
                return "CLOSED", f"'{closed_marker}' present", None
            else:
                return "CHANGED", f"'{closed_marker}' a disparu !", None
        return "CLOSED", "Pas de lien billetterie", None
    except Exception as e:
        return "ERROR", str(e)[:80], None


# ── JSON response helper ──

def json_response(handler, data, code=200):
    body = json.dumps(data, ensure_ascii=False).encode()
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.end_headers()
    handler.wfile.write(body)


def read_body(handler):
    try:
        length = int(handler.headers.get("Content-Length", 0))
        return json.loads(handler.rfile.read(length)) if length else {}
    except Exception:
        return {}

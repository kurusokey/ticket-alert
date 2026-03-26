"""GET /api/monitor/check — check all active events. Stateless: no server state needed."""
from http.server import BaseHTTPRequestHandler
from datetime import datetime
import json
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))
from lib import json_response, get_events, check_event, send_telegram

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # Accept events from query param (localStorage) or fall back to server data
        events = get_events()
        active = [ev for ev in events if ev.get("active")]

        if not active:
            return json_response(self, {"ok": False, "reason": "no_events", "results": []})

        now = datetime.now().strftime("%H:%M:%S")
        results = []

        for ev in active:
            name = ev.get("name", "?")
            st, detail, ticket_url = check_event(ev)
            url = ticket_url or ev.get("url", "")

            entry = {"event": name, "status": st, "detail": detail, "url": url, "time": now}
            results.append(entry)

            if st in ("OPEN", "CHANGED"):
                venue = ev.get("venue", "")
                msg = f"🚨🚨🚨 BILLETTERIE OUVERTE !!!\n\n🎤 {name}"
                if venue:
                    msg += f" — {venue}"
                msg += f"\n\n👉 {url}\n\nFONCE PRENDRE TES PLACES !"
                send_telegram(msg)

        json_response(self, {"ok": True, "checked": len(active), "results": results, "time": now, "v": 2})

    def do_OPTIONS(self):
        json_response(self, {})

    def log_message(self, *a):
        pass

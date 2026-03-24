"""GET /api/cron — called by Vercel Cron to check all active events."""
from http.server import BaseHTTPRequestHandler
from datetime import datetime
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from lib import json_response, get_events, get_status, save_status, check_event, send_telegram

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        status = get_status()
        if not status.get("running"):
            return json_response(self, {"skipped": True, "reason": "Monitor not running"})

        events = [ev for ev in get_events() if ev.get("active")]
        if not events:
            return json_response(self, {"skipped": True, "reason": "No active events"})

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
                logs.append({"time": now, "message": f"ALERTE {name} — {detail}", "level": "alert"})
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
        json_response(self, {"ok": True, "checked": len(events)})

    def log_message(self, *a):
        pass

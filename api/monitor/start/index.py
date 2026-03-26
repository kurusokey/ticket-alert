"""POST /api/monitor/start"""
from http.server import BaseHTTPRequestHandler
from datetime import datetime
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))
from lib import json_response, get_events, get_status, save_status, send_telegram

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        status = get_status()
        if status.get("running"):
            return json_response(self, {"ok": False, "message": "Deja en cours"})
        now = datetime.now().strftime("%H:%M:%S")
        status["running"] = True
        status["check_count"] = 0
        status["started_at"] = now
        status["logs"] = [{"time": now, "message": "Surveillance demarree", "level": "success"}]
        status["alerts"] = []
        save_status(status)
        names = ", ".join(ev["name"] for ev in get_events() if ev.get("active"))
        send_telegram(f"🔍 Ticket Alert demarre\n{names}")
        json_response(self, {"ok": True, "message": "Demarree"})

    def do_OPTIONS(self):
        json_response(self, {})

    def log_message(self, *a):
        pass

"""POST /api/monitor/stop"""
from http.server import BaseHTTPRequestHandler
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from lib import json_response, get_status, save_status, send_telegram

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        status = get_status()
        status["running"] = False
        save_status(status)
        send_telegram("⏹ Ticket Alert arrete")
        json_response(self, {"ok": True, "message": "Arretee"})

    def do_OPTIONS(self):
        json_response(self, {})

    def log_message(self, *a):
        pass

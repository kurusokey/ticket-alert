"""POST /api/events/toggle — toggle event active status. Body: {"id": "..."}"""
from http.server import BaseHTTPRequestHandler
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from lib import json_response, read_body, get_events, save_events

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = read_body(self)
        event_id = body.get("id", "")
        events = get_events()
        for ev in events:
            if ev.get("id") == event_id:
                ev["active"] = not ev.get("active", True)
        save_events(events)
        json_response(self, {"ok": True})

    def do_OPTIONS(self):
        json_response(self, {})

    def log_message(self, *a):
        pass

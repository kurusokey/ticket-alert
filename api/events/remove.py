"""POST /api/events/remove — delete event by id (body: {"id": "..."})."""
from http.server import BaseHTTPRequestHandler
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from lib import json_response, read_body, get_events, save_events

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = read_body(self)
        event_id = body.get("id", "")
        events = [ev for ev in get_events() if ev.get("id") != event_id]
        save_events(events)
        json_response(self, {"ok": True})

    def do_OPTIONS(self):
        json_response(self, {})

    def log_message(self, *a):
        pass

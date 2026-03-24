"""PUT /api/events/update — update existing event."""
from http.server import BaseHTTPRequestHandler
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from lib import json_response, read_body, get_events, save_events

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = read_body(self)
        events = get_events()
        updated = False
        for i, ev in enumerate(events):
            if ev.get("id") == body.get("id"):
                events[i] = body
                updated = True
                break
        if not updated:
            events.append(body)
        save_events(events)
        json_response(self, {"ok": True})

    def do_PUT(self):
        return self.do_POST()

    def do_OPTIONS(self):
        json_response(self, {})

    def log_message(self, *a):
        pass

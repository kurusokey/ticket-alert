"""GET /api/events — list all events. POST — create. PUT — update."""
from http.server import BaseHTTPRequestHandler
import json
import traceback
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

class handler(BaseHTTPRequestHandler):
    def _err(self, e):
        body = json.dumps({"error": str(e), "trace": traceback.format_exc()}).encode()
        self.send_response(500)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            from lib import json_response, get_events
            json_response(self, get_events())
        except Exception as e:
            self._err(e)

    def do_POST(self):
        try:
            from lib import json_response, read_body, get_events, save_events
            body = read_body(self)
            events = get_events()
            events.append(body)
            save_events(events)
            json_response(self, {"ok": True})
        except Exception as e:
            self._err(e)

    def do_PUT(self):
        try:
            from lib import json_response, read_body, get_events, save_events
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
        except Exception as e:
            self._err(e)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, *a):
        pass

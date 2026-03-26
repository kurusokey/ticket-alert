"""GET /api/monitor/status"""
from http.server import BaseHTTPRequestHandler
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", ".."))
from lib import json_response, get_status

class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        json_response(self, get_status())

    def do_OPTIONS(self):
        json_response(self, {})

    def log_message(self, *a):
        pass

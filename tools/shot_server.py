"""Receives in-game screenshots from a local test page and saves them as PNGs (for review renders).

The page POSTs a PNG body to http://127.0.0.1:8791/shot?name=<name>; it lands in shots/<name>.png at the project root
(git-ignored). Local only: binds to 127.0.0.1.

usage: py tools/shot_server.py [port]
"""
import os, re, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'shots')
os.makedirs(OUT, exist_ok=True)


class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_POST(self):
        q = parse_qs(urlparse(self.path).query)
        name = re.sub(r'[^A-Za-z0-9_.-]', '_', q.get('name', ['shot'])[0])[:80]
        data = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        path = os.path.join(OUT, name + '.png')
        with open(path, 'wb') as f:
            f.write(data)
        self.send_response(200); self._cors(); self.end_headers()
        self.wfile.write(path.encode())
        print('saved', path, len(data), flush=True)

    def log_message(self, *a):
        pass


ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 8791), H).serve_forever()

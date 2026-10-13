#!/usr/bin/env python3
"""Tiny static server for Simplify. Binds to loopback only."""
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("SIMPLIFY_PORT", "8974"))
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        # Spotify redirects back to /callback?code=...; the page itself handles it.
        if self.path.split("?", 1)[0] == "/callback":
            self.path = "/index.html"
        return super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), partial(Handler, directory=ROOT))
    except OSError as e:
        sys.exit(f"Could not start on port {PORT}: {e}")
    print(f"Simplify running at http://127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass

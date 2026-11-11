#!/usr/bin/env python3
"""Tiny static server for Simplify's Apple Music variant. Binds to loopback only."""
import os
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("SIMPLIFY_AM_PORT", "8975"))
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public-am")


class Handler(SimpleHTTPRequestHandler):
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
    print(f"Simplify (Apple Music) running at http://127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass

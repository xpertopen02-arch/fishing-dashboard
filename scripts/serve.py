"""Serves site/ with caching off, so a refresh after update.bat always shows the new data.

By default only this PC can connect. With --lan, other devices on the same network can too.
"""
import functools
import http.server
import socket
import sys
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent / "site"
PORT = 8765


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


def lan_ip():
    # Connecting a UDP socket sends nothing; it only makes the OS pick the outgoing interface.
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]


if __name__ == "__main__":
    lan = "--lan" in sys.argv
    handler = functools.partial(NoCache, directory=str(SITE))
    server = http.server.ThreadingHTTPServer(("0.0.0.0" if lan else "127.0.0.1", PORT), handler)
    print(f"http://{lan_ip() if lan else '127.0.0.1'}:{PORT}/", flush=True)
    server.serve_forever()

"""Serves site/ on localhost with caching off, so a refresh after update.bat always shows the new data."""
import functools
import http.server
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent / "site"


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    handler = functools.partial(NoCache, directory=str(SITE))
    http.server.ThreadingHTTPServer(("127.0.0.1", 8765), handler).serve_forever()

#!/usr/bin/env python3
"""AgenTV's placeholder daemon, for stage 0.

It serves the TV setup welcome page and a health endpoint on this box only
(127.0.0.1). The page tells it each time it has been drawn, so /health can
say the welcome screen is really on the TV, which is what CI's image checks
read: S0.1 for the first time, and S1.3 and S1.6 for the last, after a
switch back from Omarchy's desktop or a restart of the home screen. The real
daemon (daemon/server.ts, stage 2) takes over the same unit.
Standard library only.
"""

import argparse
import json
import os
import threading
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

AGENTV_PATH = Path(os.environ.get("AGENTV_PATH", "/usr/share/agentv"))

FILES = {
    "/": ("setup/welcome/index.html", "text/html; charset=utf-8"),
    "/logo.svg": ("branding/logo.svg", "image/svg+xml"),
}

state = {"welcome_shown_at": None, "welcome_last_shown_at": None, "welcome_shown_count": 0}
state_lock = threading.Lock()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def settings():
    """The package's settings file, or a checkout's stand-in."""
    values = {"AGENTV_VERSION": "dev", "AGENTV_CHANNEL": "dev"}
    try:
        for line in (AGENTV_PATH / "settings").read_text().splitlines():
            key, _, value = line.partition("=")
            if key in values:
                values[key] = value.strip()
    except OSError:
        pass
    return values


class Handler(BaseHTTPRequestHandler):
    server_version = "agentv"

    def send_body(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, status, data):
        self.send_body(status, json.dumps(data).encode(), "application/json")

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/health":
            with state_lock:
                shown = dict(state)
            info = settings()
            self.send_json(200, {
                "ok": True,
                "service": "agentv",
                "version": info["AGENTV_VERSION"],
                "channel": info["AGENTV_CHANNEL"],
                "screen": "welcome",
                "welcome_shown": shown["welcome_shown_at"] is not None,
                "welcome_shown_at": shown["welcome_shown_at"],
                "welcome_last_shown_at": shown["welcome_last_shown_at"],
                "welcome_shown_count": shown["welcome_shown_count"],
            })
            return

        if path in FILES:
            relative, content_type = FILES[path]
            try:
                body = (AGENTV_PATH / relative).read_bytes()
            except OSError:
                self.send_json(500, {"ok": False, "error": f"{relative} is missing"})
                return
            self.send_body(200, body, content_type)
            return

        self.send_json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if self.path == "/api/welcome-shown":
            with state_lock:
                shown_at = now()
                if state["welcome_shown_at"] is None:
                    state["welcome_shown_at"] = shown_at
                state["welcome_last_shown_at"] = shown_at
                state["welcome_shown_count"] += 1
            self.send_response(204)
            self.end_headers()
            return
        self.send_json(404, {"ok": False, "error": "not found"})

    def log_message(self, format, *args):
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=3000)
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"agentv placeholder daemon on http://127.0.0.1:{server.server_port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

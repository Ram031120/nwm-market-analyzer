#!/usr/bin/env python3
"""
Lightweight Python HTTP server for the Mauritius NWM Vegetable Analysis Web App.

Serves static files (index.html, styles.css, app.js, data/nwm_data.json, etc.)
and exposes:
  - POST /api/sync   -> runs incremental scrape_nwm.sync_nwm_data() and returns JSON status
  - GET  /api/status -> returns current SQLite database statistics
"""

from __future__ import annotations

import argparse
import functools
import json
import logging
import os
import threading
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import scrape_nwm

BASE_DIR = Path(__file__).resolve().parent
SYNC_LOCK = threading.Lock()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("nwm_server")


class NWMRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        parsed_path = urlparse(self.path).path
        if parsed_path.startswith("/api/") or parsed_path.startswith("/data/"):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def _send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle_sync(self) -> None:
        if not SYNC_LOCK.acquire(blocking=False):
            self._send_json(
                {
                    "status": "busy",
                    "message": "An NWM sync is already in progress. Please wait a moment.",
                },
                status=HTTPStatus.CONFLICT,
            )
            return
        try:
            logger.info("Triggered /api/sync (incremental update)...")
            result = scrape_nwm.sync_nwm_data(rebuild=False, use_cache=True, max_workers=8)
            self._send_json(result, status=HTTPStatus.OK)
        except Exception as exc:
            logger.exception("Error during /api/sync")
            self._send_json(
                {"status": "error", "message": str(exc)},
                status=HTTPStatus.INTERNAL_SERVER_ERROR,
            )
        finally:
            SYNC_LOCK.release()

    def do_GET(self) -> None:
        parsed_path = urlparse(self.path).path
        if parsed_path == "/api/status":
            try:
                self._send_json(scrape_nwm.get_db_status(), status=HTTPStatus.OK)
            except Exception as exc:
                self._send_json(
                    {"status": "error", "message": str(exc)},
                    status=HTTPStatus.INTERNAL_SERVER_ERROR,
                )
            return
        if parsed_path == "/api/sync":
            self._handle_sync()
            return
        super().do_GET()

    def do_POST(self) -> None:
        parsed_path = urlparse(self.path).path
        if parsed_path == "/api/sync":
            self._handle_sync()
            return
        self._send_json({"status": "error", "message": "Not found"}, status=HTTPStatus.NOT_FOUND)

    def log_message(self, format: str, *args) -> None:
        logger.info("%s - %s", self.address_string(), format % args)


def run_server(host: str = "127.0.0.1", port: int = 8000, open_browser: bool = False) -> None:
    handler_cls = functools.partial(NWMRequestHandler, directory=str(BASE_DIR))
    server = ThreadingHTTPServer((host, port), handler_cls)
    url = f"http://{host}:{port}/"
    logger.info("Mauritius NWM Web App serving at %s", url)
    logger.info("Endpoints: %s | %sapi/status | %sapi/sync", url, url, url)
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down NWM server...")
    finally:
        server.server_close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Start the Mauritius NWM Web App server")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1)")
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PORT", "8000")),
        help="Bind port (default: 8000)",
    )
    parser.add_argument(
        "--open",
        action="store_true",
        help="Automatically open the app in the default browser.",
    )
    args = parser.parse_args()
    run_server(host=args.host, port=args.port, open_browser=args.open)


if __name__ == "__main__":
    main()

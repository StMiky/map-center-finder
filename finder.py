#!/usr/bin/env python3
"""Map Center Finder — find the geographic centre of mass of a list of cities.

Running this script starts a small local web server and opens the UI in a
browser.  Everything except the map tiles and the geocoder is served locally;
geocoding requests are proxied through this process so they carry a proper
User-Agent and stay within the Nominatim usage policy (1 request/second).
"""

from __future__ import annotations

import argparse
import json
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"

NOMINATIM = "https://nominatim.openstreetmap.org"
USER_AGENT = "map-center-finder/1.0 (local desktop tool)"
MIN_REQUEST_INTERVAL = 1.0  # seconds, required by the Nominatim usage policy
NETWORK_TIMEOUT = 15.0


class Geocoder:
    """Thin, rate-limited, cached client for the Nominatim API."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._last_request = 0.0
        self._cache: dict[str, list[dict]] = {}

    def search(self, query: str, limit: int = 5) -> list[dict]:
        query = query.strip()
        if not query:
            return []
        key = f"search:{limit}:{query.lower()}"
        params = {
            "q": query,
            "format": "jsonv2",
            "limit": str(limit),
            "addressdetails": "1",
        }
        raw = self._get(key, "/search", params)
        return [self._to_place(item) for item in raw]

    def reverse(self, lat: float, lon: float) -> dict | None:
        key = f"reverse:{lat:.4f}:{lon:.4f}"
        params = {
            "lat": f"{lat:.6f}",
            "lon": f"{lon:.6f}",
            "format": "jsonv2",
            "zoom": "10",
            "addressdetails": "1",
        }
        raw = self._get(key, "/reverse", params)
        if isinstance(raw, dict):
            raw = [raw]
        if not raw:
            return None
        return self._to_place(raw[0])

    def _get(self, cache_key: str, path: str, params: dict[str, str]):
        with self._lock:
            if cache_key in self._cache:
                return self._cache[cache_key]
            wait = MIN_REQUEST_INTERVAL - (time.monotonic() - self._last_request)
            if wait > 0:
                time.sleep(wait)
            url = f"{NOMINATIM}{path}?{urllib.parse.urlencode(params)}"
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            try:
                with urllib.request.urlopen(request, timeout=NETWORK_TIMEOUT) as response:
                    payload = json.loads(response.read().decode("utf-8"))
            finally:
                self._last_request = time.monotonic()
            self._cache[cache_key] = payload
            return payload

    @staticmethod
    def _to_place(item: dict) -> dict:
        name = item.get("display_name", "")
        return {
            "name": name,
            "short_name": name.split(",")[0].strip() or name,
            "lat": float(item["lat"]),
            "lon": float(item["lon"]),
            "type": item.get("type", ""),
            "category": item.get("category", ""),
        }


GEOCODER = Geocoder()


class Handler(SimpleHTTPRequestHandler):
    """Serves the static UI plus the two geocoding endpoints."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def do_GET(self) -> None:  # noqa: N802 (name mandated by BaseHTTPRequestHandler)
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/geocode":
            self._handle_geocode(urllib.parse.parse_qs(parsed.query))
        elif parsed.path == "/api/reverse":
            self._handle_reverse(urllib.parse.parse_qs(parsed.query))
        else:
            super().do_GET()

    def _handle_geocode(self, query: dict[str, list[str]]) -> None:
        text = (query.get("q") or [""])[0]
        try:
            limit = max(1, min(10, int((query.get("limit") or ["5"])[0])))
        except ValueError:
            limit = 5
        if not text.strip():
            self._send_json({"results": []})
            return
        try:
            self._send_json({"results": GEOCODER.search(text, limit)})
        except (urllib.error.URLError, TimeoutError, ValueError) as error:
            self._send_json({"error": f"geocoding failed: {error}"}, status=502)

    def _handle_reverse(self, query: dict[str, list[str]]) -> None:
        try:
            lat = float((query.get("lat") or [""])[0])
            lon = float((query.get("lon") or [""])[0])
        except ValueError:
            self._send_json({"error": "lat and lon are required"}, status=400)
            return
        try:
            self._send_json({"result": GEOCODER.reverse(lat, lon)})
        except (urllib.error.URLError, TimeoutError, ValueError) as error:
            self._send_json({"error": f"reverse geocoding failed: {error}"}, status=502)

    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:
        if self.server.verbose:  # type: ignore[attr-defined]
            super().log_message(fmt, *args)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, *args, verbose: bool = False, **kwargs):
        self.verbose = verbose
        super().__init__(*args, **kwargs)


def pick_port(host: str, preferred: int) -> int:
    """Return `preferred` if it is free, otherwise an OS-assigned free port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((host, preferred))
            return preferred
        except OSError:
            pass
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((host, 0))
        return probe.getsockname()[1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1", help="interface to bind (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="port to bind; falls back to a free one (default: 8765)")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser window")
    parser.add_argument("-v", "--verbose", action="store_true", help="log every HTTP request")
    parser.add_argument(
        "cities",
        nargs="*",
        help="optional city names to pre-load and solve immediately, e.g. finder.py Turin Milan Genoa",
    )
    args = parser.parse_args()

    if not (STATIC_DIR / "index.html").is_file():
        parser.error(f"missing UI files in {STATIC_DIR}")

    port = pick_port(args.host, args.port)
    url = f"http://{args.host}:{port}/"
    if args.cities:
        url += "?" + urllib.parse.urlencode({"cities": "|".join(args.cities)})

    with Server((args.host, port), Handler, verbose=args.verbose) as server:
        print(f"Map Center Finder running at {url}")
        print("Press Ctrl+C to stop.")
        if not args.no_browser:
            threading.Timer(0.5, webbrowser.open, args=(url,)).start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nBye.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

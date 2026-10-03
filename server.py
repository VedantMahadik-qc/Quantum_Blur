"""Quantum Reel: one photo -> escalating Moth quantum edits -> a beat-synced vertical video.

Run:  python server.py   then open http://localhost:8000

The browser never sees MOTH_API_KEY; it talks to this proxy, which talks to Atlas.
  POST /api/upload          raw image bytes (X-Filename header) -> {asset_id, cached}
  POST /api/run             {engine, params, files: {slot: "asset:<id>"}} -> {job_id, cached}
  GET  /api/job/<id>        -> {status, outputs: [{slot, asset_id}], error}
  GET  /api/asset/<id>      -> image bytes (cached on disk; same-origin so canvas can read pixels)

Everything is cached in .cache/: identical uploads reuse their asset, identical runs reuse their
job, and finished jobs are answered from disk. Rerunning a reel with the same photo and settings
returns the same jobs instantly, even after a reload or a server restart.
"""
import hashlib
import json
import re
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import requests

import atlas

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
CACHE = ROOT / ".cache"
CACHE.mkdir(exist_ok=True)
INDEX = CACHE / "index.json"

ENGINES = {"blur-v1", "deep-fryer-v1", "telablur-v1"}
DONE = "completed"
FAILED = ("failed", "error", "cancelled")


class Index:
    """uploads: sha256 -> asset_id, runs: request hash -> job_id, jobs: job_id -> finished result."""

    def __init__(self, path):
        self.path, self.lock = path, threading.Lock()
        try:
            self.d = json.loads(path.read_text())
        except (OSError, ValueError):
            self.d = {}
        for k in ("uploads", "runs", "jobs"):
            self.d.setdefault(k, {})

    def get(self, table, key):
        with self.lock:
            return self.d[table].get(key)

    def put(self, table, key, value):
        with self.lock:
            if value is None:
                self.d[table].pop(key, None)
            else:
                self.d[table][key] = value
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.d))
            tmp.replace(self.path)


index = Index(INDEX)


def run_key(req):
    return hashlib.sha256(json.dumps(
        [req["engine"], req.get("params") or {}, req.get("files") or {}], sort_keys=True).encode()).hexdigest()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(STATIC), **kw)

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            self.close_connection = True  # the browser reloaded or closed mid-response

    def log_message(self, fmt, *args):
        if "/api/job/" not in self.path and "/api/asset/" not in self.path:  # polling is noisy
            super().log_message(fmt, *args)

    def end_headers(self):
        if not self.path.startswith("/api/asset/"):
            self.send_header("Cache-Control", "no-cache")  # always serve the current app files
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", 0)))

    def do_POST(self):
        try:
            if self.path == "/api/upload":
                return self._upload()
            if self.path == "/api/run":
                return self._run()
            self._json({"error": "not found"}, 404)
        except Exception as e:  # surface Atlas errors to the UI
            self._json({"error": str(e)}, 502)

    def _upload(self):
        data = self._body()
        ct = self.headers.get("Content-Type", "image/png")
        key = hashlib.sha256(ct.encode() + b"\0" + data).hexdigest()
        aid = index.get("uploads", key)
        if aid:
            return self._json({"asset_id": aid, "cached": True})
        aid = atlas.upload_bytes(data, self.headers.get("X-Filename", "image.png"), ct)
        index.put("uploads", key, aid)
        self._json({"asset_id": aid, "cached": False})

    def _run(self):
        req = json.loads(self._body())
        if req.get("engine") not in ENGINES:
            return self._json({"error": "unknown engine"}, 400)
        key = run_key(req)
        job_id = index.get("runs", key)
        if job_id:
            return self._json({"job_id": job_id, "cached": True})
        job_id, _ = atlas.submit(req["engine"], req.get("params") or {}, req.get("files") or {})
        index.put("runs", key, job_id)
        index.put("jobs", job_id, {"run": key})
        self._json({"job_id": job_id, "cached": False})

    def do_GET(self):
        m = re.fullmatch(r"/api/job/([\w-]+)", self.path)
        if m:
            return self._job(m[1])
        m = re.fullmatch(r"/api/asset/([\w-]+)", self.path)
        if m:
            return self._asset(m[1])
        super().do_GET()

    def _job(self, job_id):
        known = index.get("jobs", job_id) or {}
        if known.get("status") == DONE:
            return self._json({"status": DONE, "outputs": known["outputs"], "cached": True})
        try:
            r = requests.get(f"{atlas.BASE}/jobs/{job_id}", headers=atlas.H, timeout=60)
            r.raise_for_status()
            d = r.json()
            status = d.get("status")
            out = {"status": status, "outputs": [], "progress": d.get("progress")}
            if status == DONE:
                res = atlas.result(job_id)
                out["outputs"] = [{"slot": o.get("slot") or o.get("name") or "result",
                                   "asset_id": o.get("output_asset_id") or o.get("asset_id")}
                                  for o in res.get("outputs") or []]
                index.put("jobs", job_id, {**known, "status": DONE, "outputs": out["outputs"]})
            elif status in FAILED:
                out["error"] = d.get("error") or d.get("message") or json.dumps(d)[:500]
                # forget the run so pressing Generate again submits a fresh job
                if known.get("run"):
                    index.put("runs", known["run"], None)
                index.put("jobs", job_id, None)
            self._json(out)
        except Exception as e:
            self._json({"status": "unknown", "error": str(e)}, 502)

    def _asset(self, asset_id):
        path = CACHE / asset_id
        try:
            if not path.exists():
                atlas.download_asset(asset_id, path)
            data = path.read_bytes()
        except Exception as e:
            return self._json({"error": str(e)}, 502)
        ct = ("image/png" if data[:4] == b"\x89PNG" else
              "image/jpeg" if data[:2] == b"\xff\xd8" else
              "image/webp" if data[8:12] == b"WEBP" else "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Quantum Reel on http://localhost:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()

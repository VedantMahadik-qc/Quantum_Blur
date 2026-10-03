"""Minimal client for the Moth Atlas API (https://api.mothquantum.com/api/v1).

Flow: POST /engines/{id}/process -> poll GET /jobs/{id} -> GET /jobs/{id}/result
-> GET /assets/{asset_id}/download (presigned URL) -> fetch bytes.
"""
import json
import os
import time
from pathlib import Path

import requests

BASE = "https://api.mothquantum.com/api/v1"
ROOT = Path(__file__).resolve().parent


def _load_key():
    # .env wins: a stale MOTH_API_KEY exists in this machine's user environment.
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("MOTH_API_KEY="):
                return line.split("=", 1)[1].strip()
    key = os.environ.get("MOTH_API_KEY")
    if key:
        return key
    raise RuntimeError("Put MOTH_API_KEY in .env or the environment")


KEY = _load_key()
H = {"Authorization": f"Bearer {KEY}"}


def engine(engine_id):
    r = requests.get(f"{BASE}/engines/{engine_id}", headers=H, timeout=60)
    r.raise_for_status()
    return r.json()


MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".ogg": "audio/ogg",
        ".mid": "audio/midi", ".midi": "audio/midi", ".json": "application/json",
        ".zip": "application/zip"}


def upload(path, content_type=None):
    """Create asset -> PUT bytes to presigned URL -> complete. Returns asset_id."""
    path = Path(path)
    ct = content_type or MIME.get(path.suffix.lower(), "application/octet-stream")
    return upload_bytes(path.read_bytes(), path.name, ct)


def upload_bytes(data, filename, ct):
    r = requests.post(f"{BASE}/assets", headers=H, timeout=60,
                      json={"filename": filename, "content_type": ct, "size_bytes": len(data)})
    if not r.ok:
        raise RuntimeError(f"create asset failed {r.status_code}: {r.text[:1000]}")
    d = r.json()
    up = d["upload"]
    put = requests.request(up.get("method", "PUT"), up["url"], headers=up.get("headers") or {},
                           data=data, timeout=600)
    put.raise_for_status()
    c = requests.post(f"{BASE}/assets/{d['asset_id']}/complete", headers=H, timeout=120)
    if not c.ok:
        raise RuntimeError(f"complete asset failed {c.status_code}: {c.text[:1000]}")
    return d["asset_id"]


def submit(engine_id, params=None, files=None):
    """files: {slot_name: path or 'asset:<id>'}. To chain jobs, pass the previous job's output asset id."""
    body = {"params": params or {}}
    if files:
        body["input_files"] = {
            slot: (p[len("asset:"):] if str(p).startswith("asset:") else
                   p if str(p).startswith("job:") else upload(p))
            for slot, p in files.items()}
    r = requests.post(f"{BASE}/engines/{engine_id}/process", headers=H, json=body, timeout=300)
    if not r.ok:
        raise RuntimeError(f"submit {engine_id} failed {r.status_code}: {r.text[:2000]}")
    d = r.json()
    return d.get("jobId") or d.get("job_id") or d.get("id"), d


def wait(job_id, timeout=1800, interval=2.0, verbose=True):
    t0 = time.time()
    last = None
    while True:
        r = requests.get(f"{BASE}/jobs/{job_id}", headers=H, timeout=60)
        r.raise_for_status()
        d = r.json()
        st = d.get("status")
        if verbose and st != last:
            print(f"  [{job_id[:8]}] {st} ({time.time() - t0:.0f}s)")
            last = st
        if st == "completed":
            return d
        if st in ("failed", "error", "cancelled"):
            raise RuntimeError(f"job {job_id} {st}: {json.dumps(d)[:2000]}")
        if time.time() - t0 > timeout:
            raise TimeoutError(job_id)
        time.sleep(interval)


def result(job_id):
    r = requests.get(f"{BASE}/jobs/{job_id}/result", headers=H, timeout=60)
    r.raise_for_status()
    return r.json()


def download_asset(asset_id, dest):
    r = requests.get(f"{BASE}/assets/{asset_id}/download", headers=H, timeout=60)
    r.raise_for_status()
    url = r.json().get("download_url") or r.json().get("url")
    blob = requests.get(url, timeout=600)  # presigned URL: no auth header
    blob.raise_for_status()
    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    Path(dest).write_bytes(blob.content)
    return Path(dest)


def run(engine_id, params=None, files=None, out_dir=None, prefix="", verbose=True):
    """Submit, wait, download every output file. Returns (job_id, result_json, {slot: path})."""
    job_id, _ = submit(engine_id, params, files)
    if verbose:
        print(f"{engine_id}: job {job_id}")
    status = wait(job_id, verbose=verbose)
    res = result(job_id)
    paths = {}
    if out_dir:
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        outputs = res.get("outputs") or status.get("outputs") or []
        for o in outputs:
            aid = o.get("output_asset_id") or o.get("asset_id")
            if not aid:
                continue
            slot = o.get("slot") or o.get("name") or "result"
            fname = o.get("filename") or o.get("file_name") or slot
            paths[slot] = download_asset(aid, out_dir / f"{prefix}{fname}")
        (out_dir / f"{prefix}job_{job_id}.json").write_text(
            json.dumps({"engine": engine_id, "job_id": job_id, "params": params,
                        "inputs": {k: str(v) for k, v in (files or {}).items()},
                        "status": status, "result": res}, indent=2))
    return job_id, res, paths

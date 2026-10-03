"""Re-download results for jobs already submitted (safe to re-run any time).

Reads the saved job IDs from each challenge's jobs.json and fetches whatever has finished.
"""
import json
import zipfile
from pathlib import Path

import requests

import atlas

ROOT = Path(__file__).resolve().parent
SETS = [
    (ROOT / "01_one_image/output/jobs.json", ROOT / "01_one_image/output", ".png", False),
    (ROOT / "02_audible/midi/blur_jobs.json", ROOT / "02_audible/midi", ".mid", False),
    (ROOT / "03_three_dimensions/shaders/jobs.json", ROOT / "03_three_dimensions/shaders", ".zip", True),
]

for jobs_file, out_dir, ext, unzip in SETS:
    if not jobs_file.exists():
        continue
    for name, jid in json.loads(jobs_file.read_text())["jobs"].items():
        fname = f"lullaby_{name}{ext}" if ext == ".mid" else f"{name}{ext}"
        dest = out_dir / fname
        if dest.exists():
            print("have   ", dest.name)
            continue

        st = requests.get(f"{atlas.BASE}/jobs/{jid}", headers=atlas.H, timeout=60).json()["status"]
        if st != "completed":
            print(f"{st:8}", name)
            continue
        res = atlas.result(jid)
        atlas.download_asset(res["outputs"][0]["output_asset_id"], dest)
        if unzip:
            with zipfile.ZipFile(dest) as z:
                z.extractall(out_dir / name)
        print("fetched", dest.name)

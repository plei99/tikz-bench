"""Download every source PDF listed in data/sources.json into sources/.

Each entry's `url` is fetched to its `pdf` path unless a valid PDF is already
there. Google Drive "view" links and arXiv abstract links are turned into direct
downloads. Entries with `rotate` are drawn sideways in the original; the original
is saved next to `pdf` and an upright copy is written with rotate_pdf.py.

Usage: python scripts/download_sources.py [--doc DOC_ID ...]
"""

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

import pymupdf as fitz

ROOT = Path(__file__).resolve().parent.parent


def direct_url(url):
    m = re.match(r"https://drive\.google\.com/file/d/([-\w]+)", url)
    if m:
        return f"https://drive.usercontent.google.com/download?id={m[1]}&export=download&confirm=t"
    m = re.match(r"https://arxiv\.org/abs/(.+)", url)
    if m:
        return f"https://arxiv.org/pdf/{m[1]}"
    return url


def is_pdf(path):
    try:
        with fitz.open(path) as doc:
            return len(doc) > 0
    except Exception:
        return False


def fetch(url, path, tries=3):
    path.parent.mkdir(parents=True, exist_ok=True)
    for attempt in range(tries):
        # One file at a time: some hosts (drorbn.net, MPIM) truncate parallel downloads.
        subprocess.run(["curl", "-sSL", "--max-time", "1200", "-A", "Mozilla/5.0",
                        "-o", str(path), url])
        if is_pdf(path):
            return True
        time.sleep(5 * (attempt + 1))  # Drive sometimes answers with an error page
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", nargs="*")
    args = ap.parse_args()

    sources = json.loads((ROOT / "data" / "sources.json").read_text())
    failed = []
    for doc_id, src in sources.items():
        if args.doc and doc_id not in args.doc:
            continue
        pdf = ROOT / src["pdf"]
        if is_pdf(pdf):
            continue
        target = pdf.with_name(pdf.name.replace("_upright", "")) if src.get("rotate") else pdf
        if not is_pdf(target) and not fetch(direct_url(src["url"]), target):
            failed.append(doc_id)
            continue
        if src.get("rotate"):
            subprocess.run([sys.executable, str(ROOT / "scripts" / "rotate_pdf.py"), str(target),
                            str(pdf), "--degrees", str(src["rotate"])], check=True)
        print(f"{doc_id}: ok")
    if failed:
        print("FAILED (retry later):", " ".join(failed))
        sys.exit(1)


if __name__ == "__main__":
    main()

"""Crop hand-picked regions out of PDFs.

Reads a JSON file mapping doc ids to regions:
  {"<doc_id>": {"pdf": "sources/...pdf",
                "regions": [{"page": 3, "bbox": [x0, y0, x1, y1], "note": "..."}]}}
with bboxes in PDF points. Writes <out_dir>/<doc_id>/<doc_id>_pNNN_K.png and
<out_dir>/<doc_id>/figures.jsonl.

Usage: python scripts/crop_regions.py <regions.json> <out_dir> [--dpi 300] [--doc ID]
"""

import argparse
import json
from collections import defaultdict
from pathlib import Path

import pymupdf as fitz


def crop(pdf, regions, out_dir, doc_id, dpi=300):
    """Crop `regions` of `pdf` to PNGs in `out_dir`; return metadata records."""
    doc = fitz.open(pdf)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    counter = defaultdict(int)
    records = []
    for reg in sorted(regions, key=lambda r: (r["page"], r["bbox"][1], r["bbox"][0])):
        page = doc[reg["page"] - 1]
        clip = fitz.Rect(reg["bbox"]) & page.rect
        k = counter[reg["page"]]
        counter[reg["page"]] += 1
        name = f"{doc_id}_p{reg['page']:03d}_{k}.png"
        page.get_pixmap(dpi=dpi, clip=clip).save(out / name)
        records.append({
            "file": name,
            "doc": doc_id,
            "page": reg["page"],
            "bbox_pt": [round(v, 1) for v in clip],
            "figure_number": None,
            "caption": None,
            "note": reg.get("note"),
        })
    return records


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("regions")
    ap.add_argument("out_dir")
    ap.add_argument("--dpi", type=int, default=300)
    ap.add_argument("--doc", help="only process this doc id")
    args = ap.parse_args()

    spec = json.loads(Path(args.regions).read_text())
    for doc_id, entry in spec.items():
        if args.doc and doc_id != args.doc:
            continue
        out = Path(args.out_dir) / doc_id
        records = crop(entry["pdf"], entry["regions"], out, doc_id, args.dpi)
        with open(out / "figures.jsonl", "w") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")
        print(f"{doc_id}: {len(records)} regions")


if __name__ == "__main__":
    main()

"""Crop vector figures out of typeset (LaTeX-produced) PDFs.

Figures are located by clustering vector drawings and growing each cluster to
absorb nearby label text. Each "Figure N." caption then claims every cluster
(and sub-caption text) between itself and the nearest paragraph above it.
Clusters not claimed by a caption are merged with their neighbours and kept
as uncaptioned figures (inline diagrams, commutative diagrams, ...).

Usage: python scripts/extract_typeset.py <pdf> <out_dir> <doc_id> [--dpi 300]
Writes <out_dir>/<doc_id>_pNNN_K.png plus <out_dir>/figures.jsonl.
"""

import argparse
import json
import re
from pathlib import Path

import pymupdf as fitz

CAPTION_RE = re.compile(r"^\s*(Figure|Fig\.)\s*(\d+)\s*[.:]")
MIN_SIDE = 22  # pt; smaller groups are rules, bullets, inline symbols, ...
MIN_PATHS = 4  # uncaptioned groups with fewer paths are boxed text, brackets, ...
PAD = 4  # pt of whitespace around each crop


class Line:
    def __init__(self, rect, text, block_width):
        # block_width: longest line in the enclosing text block.
        self.rect, self.text, self.block_width = rect, text, block_width
        self.caption = CAPTION_RE.match(text) is not None


def header_bottom(doc):
    """y1 of the running header: the median y1 of each page's topmost line."""
    tops = sorted(
        min((b["bbox"][3] for b in page.get_text("dict")["blocks"] if b.get("lines")),
            default=0)
        for page in doc)
    return tops[len(tops) // 2] if tops else 0


def text_lines(page, header_y=0):
    """Text lines, minus running headers and page numbers."""
    h = page.rect.height
    lines = []
    for block in page.get_text("dict")["blocks"]:
        bw = max((l["bbox"][2] - l["bbox"][0] for l in block.get("lines", [])), default=0)
        for line in block.get("lines", []):
            r = fitz.Rect(line["bbox"])
            text = "".join(s["text"] for s in line["spans"]).strip()
            if text and r.y1 > max(header_y + 2, 0.075 * h) and r.y0 < 0.93 * h:
                lines.append(Line(r, text, bw))
    return lines


def union(rects):
    out = fitz.Rect(rects[0])
    for r in rects[1:]:
        out |= r
    return out


def find_figures(page, header_y=0):
    drawings = page.get_drawings()
    if not drawings:
        return []
    clusters = [fitz.Rect(r) for r in page.cluster_drawings(
        drawings=drawings, x_tolerance=6, y_tolerance=6)]
    clusters = [r for r in clusters if max(r.width, r.height) > MIN_SIDE]
    if not clusters:
        return []

    lines = text_lines(page, header_y)
    body_width = max((l.rect.width for l in lines), default=page.rect.width)
    captions = sorted((l for l in lines if l.caption), key=lambda l: l.rect.y0)

    def is_body(l):
        """Paragraph text: its text block has a full-width line."""
        return l.block_width > 0.6 * body_width

    # Grow clusters with label text: lines mostly inside, or narrow-block lines
    # touching the drawing. Iterate because labels can chain.
    free = [l for l in lines if not l.caption]
    changed = True
    while changed:
        changed = False
        for i, c in enumerate(clusters):
            grown = c + (-6, -6, 6, 6)
            keep = []
            for l in free:
                inside = (c & l.rect).get_area() > 0.3 * l.rect.get_area()
                if inside or (grown.intersects(l.rect) and not is_body(l)):
                    clusters[i] = c = c | l.rect
                    changed = True
                else:
                    keep.append(l)
            free = keep

    figures = []
    claimed = set()
    prev_bottom = 0
    def x_overlap(a, b):
        return a.x0 < b.x1 and a.x1 > b.x0

    for cap in captions:
        # The band above the caption, up to the nearest paragraph / caption.
        # Only text in the caption's column counts (wrapfigure puts
        # paragraphs beside the figure).
        top = prev_bottom
        for l in free:
            if is_body(l) and l.rect.y1 <= cap.rect.y0 + 1 and x_overlap(l.rect, cap.rect):
                top = max(top, l.rect.y1)
        prev_bottom = cap.rect.y1
        # Test the centre: some included graphics have a bounding box that
        # runs into the caption.
        members = [i for i, c in enumerate(clusters)
                   if i not in claimed and c.y0 >= top - 2
                   and (c.y0 + c.y1) / 2 < cap.rect.y0 and x_overlap(c, cap.rect)]
        if not members:
            continue  # e.g. a "figure" that is a typeset matrix
        claimed.update(members)
        rect = union([clusters[i] for i in members])
        # Sub-captions such as "(a) ..." sit between the drawings and caption.
        for l in free:
            if (l.rect.y0 >= rect.y0 - 1 and l.rect.y1 <= cap.rect.y0 + 1
                    and l.rect.x0 < rect.x1 and l.rect.x1 > rect.x0):
                rect |= l.rect
        rect.y1 = min(rect.y1, cap.rect.y0 - PAD - 1)
        figures.append((rect, caption_text(lines, cap)))

    # Unclaimed clusters: merge neighbours not separated by free text.
    rest = [clusters[i] for i in range(len(clusters)) if i not in claimed]

    def separated(a, b):
        top, bot = (a, b) if a.y0 <= b.y0 else (b, a)
        lo, hi = top.y1, bot.y0
        if hi <= lo:
            return False
        return any(l.rect.y0 >= lo - 1 and l.rect.y1 <= hi + 1 for l in free + captions)

    merged = True
    while merged:
        merged = False
        for i in range(len(rest)):
            for j in range(i + 1, len(rest)):
                if rest[i].intersects(rest[j]) or not separated(rest[i], rest[j]):
                    rest[i] |= rest.pop(j)
                    merged = True
                    break
            if merged:
                break
    for rect in rest:
        paths = sum(1 for d in drawings if rect.contains(d["rect"]))
        if paths >= MIN_PATHS:
            figures.append((rect, None))

    figures = [(r, c) for r, c in figures if r.width > MIN_SIDE and r.height > MIN_SIDE]
    return sorted(figures, key=lambda f: (f[0].y0, f[0].x0))


def caption_text(lines, cap):
    """Caption line plus the continuation lines of the same paragraph."""
    out, last = [], cap.rect
    for l in sorted(lines, key=lambda l: l.rect.y0):
        if l.rect.y0 < cap.rect.y0 - 1:
            continue
        if l is cap or (0 <= l.rect.y0 - last.y1 < 4 and l.rect.x0 >= cap.rect.x0 - 30):
            out.append(l.text)
            last = l.rect
        elif out:
            break
    return " ".join(out)


def extract(pdf, out_dir, doc_id, dpi=300):
    """Crop every figure in `pdf` to PNGs in `out_dir`; return metadata records."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(pdf)
    header_y = header_bottom(doc)
    records = []
    for page in doc:
        for k, (rect, caption) in enumerate(find_figures(page, header_y)):
            clip = (rect + (-PAD, -PAD, PAD, PAD)) & page.rect
            name = f"{doc_id}_p{page.number + 1:03d}_{k}.png"
            page.get_pixmap(dpi=dpi, clip=clip).save(out / name)
            m = CAPTION_RE.match(caption) if caption else None
            records.append({
                "file": name,
                "doc": doc_id,
                "page": page.number + 1,
                "bbox_pt": [round(v, 1) for v in clip],
                "figure_number": int(m.group(2)) if m else None,
                "caption": caption,
            })
    return records


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("out_dir")
    ap.add_argument("doc_id")
    ap.add_argument("--dpi", type=int, default=300)
    args = ap.parse_args()

    records = extract(args.pdf, args.out_dir, args.doc_id, args.dpi)
    with open(Path(args.out_dir) / "figures.jsonl", "w") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")
    print(f"{args.doc_id}: {len(records)} figures, "
          f"{sum(r['caption'] is not None for r in records)} captioned")


if __name__ == "__main__":
    main()

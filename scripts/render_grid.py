"""Render PDF pages with a labelled coordinate grid (in PDF points).

Used to pick crop boxes by eye for documents whose figures cannot be found
automatically (e.g. handwritten notes). Grid lines every 50pt, labelled.

Usage: python scripts/render_grid.py <pdf> <out_dir> [--dpi 100] [--pages 1,2,5]
"""

import argparse
from pathlib import Path

import pymupdf as fitz
from PIL import Image, ImageDraw


def _size_and_samples(pix):
    return (pix.width, pix.height), pix.samples


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("out_dir")
    ap.add_argument("--dpi", type=int, default=100)
    ap.add_argument("--pages", help="comma-separated 1-based page numbers")
    args = ap.parse_args()

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(args.pdf)
    pages = [int(p) for p in args.pages.split(",")] if args.pages else range(1, len(doc) + 1)
    for pno in pages:
        page = doc[pno - 1]
        w, h = page.rect.width, page.rect.height
        # Draw the grid on the rendered image: adding it to the PDF page instead
        # is very slow for ink-heavy pages.
        img = Image.frombytes("RGB", *_size_and_samples(page.get_pixmap(dpi=args.dpi)))
        draw = ImageDraw.Draw(img)
        k = args.dpi / 72
        for x in range(0, int(w) + 1, 50):
            draw.line([(x * k, 0), (x * k, h * k)], fill=(255, 150, 150))
        for y in range(0, int(h) + 1, 50):
            draw.line([(0, y * k), (w * k, y * k)], fill=(255, 150, 150))
        for x in range(0, int(w) + 1, 50):
            for y in range(0, int(h) + 1, 100):
                draw.text((x * k + 2, y * k + 1), str(x), fill=(230, 0, 0))
        for y in range(0, int(h) + 1, 50):
            for x in range(0, int(w) + 1, 150):
                draw.text((x * k + 2, y * k - 11), str(y), fill=(0, 0, 230))
        img.save(out / f"p{pno:03d}.png")
    print(f"rendered {len(pages)} pages of {args.pdf} ({w:.0f}x{h:.0f}pt) to {out}")


if __name__ == "__main__":
    main()

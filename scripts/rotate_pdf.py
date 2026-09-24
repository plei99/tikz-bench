"""Write an upright copy of a PDF whose content is drawn sideways.

The pages are placed (as vectors) into a new PDF, rotated by --degrees
counter-clockwise, so crop boxes can be picked in upright coordinates.

Usage: python scripts/rotate_pdf.py <in.pdf> <out.pdf> [--degrees 90]
"""

import argparse

import pymupdf as fitz


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--degrees", type=int, default=90, choices=[90, 180, 270])
    args = ap.parse_args()

    src = fitz.open(args.src)
    out = fitz.open()
    for page in src:
        w, h = page.rect.width, page.rect.height
        if args.degrees != 180:
            w, h = h, w
        new = out.new_page(width=w, height=h)
        new.show_pdf_page(new.rect, src, page.number, rotate=args.degrees)
    out.save(args.dst, garbage=3, deflate=True)
    print(f"{args.src} -> {args.dst} ({len(out)} pages)")


if __name__ == "__main__":
    main()

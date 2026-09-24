# Selecting figures in handwritten notes

Handwritten notes can't be parsed automatically, so crop boxes are picked by eye on
grid renders (`scripts/render_grid.py`) and stored in `data/regions/<doc_id>.json`:

```json
{"<doc_id>": {"pdf": "sources/...pdf",
              "regions": [{"page": 3, "bbox": [x0, y0, x1, y1], "note": "short description"}]}}
```

Pages are 1-based; bboxes are in PDF points with y growing downward (the grid has
lines every 50pt; x labels red, y labels blue).

## What counts as a figure

Include any hand-drawn picture or diagram, for example:
- curves, Riemann surfaces, spheres, tubes, cylinders, 3D boxes/sheets;
- polytopes, polygons, lattices, hyperplane arrangements, plots with axes;
- graphs, quivers, trees, Young diagrams, Maya diagrams, box piles;
- knots, braids, strand/R-matrix pictures;
- commutative diagrams and maps between pictures (e.g. a curve --f--> a sphere is
  ONE figure, including the arrow and labels);
- equations whose content is mainly pictures (crop the whole equation as one region).

Include the figure's own labels (letters or formulas written on or right next to it).

Exclude:
- plain handwritten text or formulas; annotation arrows that only link text;
  underlines; boxes or brackets around text; date/time headers;
- photos and pasted screenshots (e.g. a photo of a blackboard); only hand-drawn ink counts;
- tiny pictograms used as a symbol inside a line of text;
- decorative artwork (title-page illustrations, icons).

## Cropping rules

- Separate unrelated drawings into separate regions.
- Don't cut strokes or labels; leave a ~5-10pt margin.
- Avoid unrelated text where possible; a slight intrusion is OK only if unavoidable.
- Exported notes often repeat content across page breaks. If a figure spans a
  break or appears on two pages, crop only the copy that is complete. If it is
  never complete on a single page, skip it.
- If the author re-pastes the same drawing, crop it once.
- `note`: a short description of what the figure shows.

## Verifying

```sh
.venv/bin/python scripts/crop_regions.py data/regions/<doc_id>.json /tmp/verify --dpi 80
```

View every crop and fix boxes that cut off strokes or labels or include too much
unrelated text.

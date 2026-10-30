// Inline resolved SVG styles before rasterizing: downloaded images have no
// stylesheet, inherited theme variables, or access to the page's DOM.
const properties = [
  "color",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "opacity",
  "display",
  "visibility",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant-numeric",
  "letter-spacing",
  "text-anchor",
  "dominant-baseline",
  "paint-order",
];

export async function downloadChartPng(
  source: SVGSVGElement,
  filename: string,
  note = "",
) {
  await document.fonts.ready;
  const svg = source.cloneNode(true) as SVGSVGElement;
  const originals = [source, ...source.querySelectorAll("*")];
  const copies = [svg, ...svg.querySelectorAll("*")];
  originals.forEach((element, i) => {
    const style = getComputedStyle(element);
    const copy = copies[i] as SVGElement;
    for (const property of properties) {
      copy.style.setProperty(property, style.getPropertyValue(property));
    }
  });
  const view = source.viewBox.baseVal;
  const bounds = source.getBBox();
  const x = Math.min(view.x, bounds.x), y = Math.min(view.y, bounds.y);
  const width = Math.ceil(
    Math.max(view.x + view.width, bounds.x + bounds.width) - x,
  );
  const height = Math.ceil(
    Math.max(view.y + view.height, bounds.y + bounds.height) - y,
  );
  svg.setAttribute("viewBox", [x, y, width, height].join(" "));
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  const image = new Image();
  // data: images are already allowed by the site's CSP. SVG contains only
  // the chart's vector marks and inline logos; no foreignObject or network.
  image.src = "data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(new XMLSerializer().serializeToString(svg));
  await image.decode();
  const canvas = document.createElement("canvas");
  const padding = 24, footer = note ? 32 : 0, scale = 2;
  canvas.width = (width + padding * 2) * scale;
  canvas.height = (height + padding * 2 + footer) * scale;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.scale(scale, scale);
  const theme = getComputedStyle(source);
  context.fillStyle = theme.getPropertyValue("--bg").trim();
  context.fillRect(0, 0, canvas.width / scale, canvas.height / scale);
  context.drawImage(image, padding, padding, width, height);
  if (note) {
    context.fillStyle = theme.getPropertyValue("--muted").trim();
    context.font = "12px " + theme.fontFamily;
    context.fillText(note, padding, height + padding + 24, width);
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(new Error("PNG encoding failed")),
      "image/png",
    );
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Keep the URL alive until the browser has begun the download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

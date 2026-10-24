import { createHash } from "node:crypto";

export const scriptHash = (code: string) =>
  `sha256-${createHash("sha256").update(code).digest("base64")}`;

// GitHub Pages serves these files directly, so deliver CSP in the document.
// Only hashes authorize scripts; 'self' would trust every project on this
// github.io origin. Hashed loaders create SRI-checked module entries so that
// strict-dynamic also permits their dependencies across browsers. An inline
// script is authorized only if it is one the build inlined itself, so markup
// injected into the page at build time cannot gain a hash.
export function securePage(
  html: string,
  scripts: ReadonlyMap<string, string>,
  inlineScripts: ReadonlySet<string>,
) {
  const hashes = new Set<string>();
  let inline = "";
  html = new HTMLRewriter()
    .on("script", {
      element(el) {
        const src = el.getAttribute("src");
        // Embedded results are data, not a JavaScript entry point.
        if (src === null && el.getAttribute("type") === "application/json") {
          return;
        }
        if (src !== null) {
          const hash = scripts.get(src.split("?")[0]!);
          if (!hash || el.getAttribute("type") !== "module") {
            throw new Error(`Unexpected script in generated HTML: ${src}`);
          }
          const loader = `addEventListener("DOMContentLoaded", () => {
  const script = document.createElement("script");
  script.type = "module";
  script.src = ${JSON.stringify(src).replaceAll("<", "\\u003c")};
  script.integrity = ${JSON.stringify(hash)};
  document.head.append(script);
}, { once: true });`;
          el.replace(`<script>${loader}</script>`, { html: true });
          hashes.add(scriptHash(loader));
        } else {
          inline = "";
          el.onEndTag(() => {
            if (!inlineScripts.has(inline)) {
              throw new Error("Unexpected inline script in generated HTML");
            }
            hashes.add(scriptHash(inline));
          });
        }
      },
      text(chunk) {
        inline += chunk.text;
      },
    })
    .transform(html);
  const policy = [
    "default-src 'none'",
    `script-src 'strict-dynamic' ${[...hashes].map((h) => `'${h}'`).join(" ")}`,
    "script-src-attr 'none'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'none'",
  ].join("; ");
  // This must precede every script, stylesheet, and preload in the shell.
  return new HTMLRewriter().on("head", {
    element(el) {
      el.prepend(
        `<meta http-equiv="Content-Security-Policy" content="${policy}">`,
        { html: true },
      );
    },
  }).transform(html);
}

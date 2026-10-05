import { validateSnapshot } from "./validate.ts";
import { initialState, ranked } from "../src/lib/model.js";

const root = new URL("../_site/", import.meta.url);
const data = JSON.parse(
  await Deno.readTextFile(new URL("data/results.json", root)),
);
validateSnapshot(data);
const html = await Deno.readTextFile(new URL("index.html", root));
const state = initialState(data);
for (const row of ranked(data, state)) {
  if (!html.includes(`data-config="${row.id}"`)) {
    throw new Error(`Run missing from initial HTML: ${row.id}`);
  }
}
const allowed = new Set([
  "index.html",
  "styles.css",
  "app.js",
  "favicon.svg",
  ".nojekyll",
  "lib/model.js",
  "lib/render.js",
  "data/results.json",
]);
async function walk(dir: URL, prefix = "") {
  for await (const entry of Deno.readDir(dir)) {
    const name = prefix + entry.name;
    if (entry.isDirectory) {
      await walk(new URL(entry.name + "/", dir), name + "/");
    } else if (!allowed.has(name)) {
      throw new Error(`Unexpected published file: ${name}`);
    }
  }
}
await walk(root);
for (const name of allowed) await Deno.stat(new URL(name, root));
function checkLink(link: string) {
  // Cache-busting versions (?v=...) do not change which file is served.
  const url = link.split("?")[0];
  if (/^https?:|^#/.test(url)) return;
  if (!url.startsWith("/")) {
    throw new Error(`Unexpected relative asset URL: ${url}`);
  }
  // Confirm all local assets, including a repository Pages prefix, resolve.
  const asset = [...allowed].find((name) =>
    url === "/" + name || url.endsWith("/" + name)
  );
  if (!asset && !url.endsWith("/")) {
    throw new Error(`Unknown local link: ${url}`);
  }
}
for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
  checkLink(match[1]);
}
const importMap = html.match(/<script type="importmap">([^<]*)<\/script>/);
for (
  const [from, to] of Object.entries(
    JSON.parse(importMap?.[1] ?? '{"imports":{}}').imports as Record<
      string,
      string
    >,
  )
) {
  checkLink(from);
  checkLink(to);
}
if (!html.includes('id="benchmark-data"') || !html.includes('id="chart"')) {
  throw new Error("Missing static results");
}
console.log(
  `Verified ${allowed.size} public files and ${
    ranked(data, state).length
  } initial chart configurations. No private evaluation files included.`,
);

// Checks the built site in dist/: only the expected public files, every
// initial run on both pages, and local links that resolve.
import { validateSnapshot } from "./validate";
import { initialState, ranked, type Snapshot } from "../lib/model";

const root = `${import.meta.dir}/../dist/`;
const data: Snapshot = await Bun.file(`${root}data/results.json`).json();
validateSnapshot(data);
// One page per language; every check below runs on each.
const pages = ["index.html", "zh/index.html"];
const state = initialState(data);
const allowed = new Set([
  ...pages,
  "styles.css",
  "favicon.svg",
  ".nojekyll",
  "js/app.js",
  "data/results.json",
]);
for (const name of new Bun.Glob("**").scanSync({ cwd: root, dot: true })) {
  if (!allowed.has(name)) throw new Error(`Unexpected published file: ${name}`);
}
for (const name of allowed) {
  if (!(await Bun.file(root + name).exists())) {
    throw new Error(`Missing published file: ${name}`);
  }
}
function checkLink(link: string) {
  // Cache-busting versions (?v=...) do not change which file is served.
  const url = link.split("?")[0]!;
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
for (const page of pages) {
  const html = await Bun.file(root + page).text();
  for (const row of ranked(data, state)) {
    if (!html.includes(`data-config="${row.id}"`)) {
      throw new Error(`Run missing from ${page}: ${row.id}`);
    }
  }
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    checkLink(match[1]!);
  }
  if (!html.includes('id="benchmark-data"') || !html.includes('id="chart"')) {
    throw new Error(`Missing static results in ${page}`);
  }
  if (/__REV__|__bun_f|\.rsc"/.test(html)) {
    throw new Error(`Unfinished Bake output in ${page}`);
  }
}
console.log(
  `Verified ${allowed.size} public files, ${pages.length} languages and ${
    ranked(data, state).length
  } initial chart configurations. No private evaluation files included.`,
);

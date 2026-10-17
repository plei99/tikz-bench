// Runs after `bun build --app` and turns dist/ into the site:
//
// - Bake's React shell owns <html> and <body>, so each page's
//   <template data-shell> carries the attributes <html> needs (lang and the
//   default theme), and the shell's own <title> goes.
// - Pages have no client components, so Bake ships no client runtime; the
//   inlined RSC payload and the .rsc files that only it would read go too.
// - public/ and the snapshot are copied, client/app.ts is bundled into
//   js/app.js, and asset URLs get a hash of the published assets.
import { cp, rm } from "node:fs/promises";

const OUT = "dist";

await cp("public", OUT, { recursive: true });
await cp("data/results.json", `${OUT}/data/results.json`);
const app = await Bun.build({
  entrypoints: ["client/app.ts"],
  target: "browser",
  format: "esm",
  minify: true,
});
if (!app.success) {
  throw new AggregateError(app.logs, "Bundling client/app.ts failed");
}
await Bun.write(`${OUT}/js/app.js`, app.outputs[0]!);

const hash = new Bun.CryptoHasher("sha256");
for (const file of ["styles.css", "js/app.js", "data/results.json"]) {
  hash.update(await Bun.file(`${OUT}/${file}`).bytes());
}
const rev = hash.digest("hex").slice(0, 8);

function finishPage(html: string) {
  const shell: Record<string, string> = {};
  html = new HTMLRewriter()
    .on("template[data-shell]", {
      element(el) {
        for (const [name, value] of el.attributes) shell[name] = value;
        el.remove();
      },
    })
    .transform(html);
  return new HTMLRewriter()
    .on("html", {
      element(el) {
        if (shell["data-lang"]) el.setAttribute("lang", shell["data-lang"]);
        if (shell["data-theme"]) {
          el.setAttribute("data-theme", shell["data-theme"]);
        }
      },
    })
    .transform(html)
    .replace("<title>Bun + React Server Components</title>", "")
    .replace(
      /<script>\(self\.__bun_f\|\|=\[\]\)\.push\([\s\S]*?<\/script>/g,
      "",
    )
    .replaceAll("__REV__", rev);
}

let pages = 0;
for (const file of new Bun.Glob("**/index.html").scanSync(OUT)) {
  const path = `${OUT}/${file}`;
  await Bun.write(path, finishPage(await Bun.file(path).text()));
  pages++;
}
for (const file of new Bun.Glob("**/*.rsc").scanSync(OUT)) {
  await rm(`${OUT}/${file}`);
}
await rm(`${OUT}/_bun`, { recursive: true, force: true });
console.log(`Finished ${pages} pages in ${OUT}/`);

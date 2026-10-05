import lume from "lume/mod.ts";
import { validateSnapshot } from "./scripts/validate.ts";

validateSnapshot(
  JSON.parse(
    Deno.readTextFileSync(new URL("./src/data/results.json", import.meta.url)),
  ),
);

// Only this directory is publishable. The benchmark's private data is outside it.
const site = lume({
  src: "./src",
  dest: "./_site",
  server: { port: 3000, open: false, debugBar: false },
});

site.copy("styles.css");
site.copy("app.js");
site.copy("lib");
site.copy("data");
site.copy("favicon.svg");
site.copy(".nojekyll");

// Extract selected public README sections so the website keeps the author's voice.
const readme = Deno.readTextFileSync(new URL("../README.md", import.meta.url));
const section = (heading: string) => {
  const start = readme.indexOf(`## ${heading}\n`);
  if (start < 0) throw new Error(`README section missing: ${heading}`);
  const content = readme.slice(start + heading.length + 4);
  const end = content.search(/^## /m);
  return (end < 0 ? content : content.slice(0, end)).trim();
};
const running = section("Running it");
site.data("readme", {
  // Only the opening sentence; the paragraph may continue with details.
  intro: readme.match(/This benchmark[\s\S]*?\.(?=\s)/)?.[0].replace(
    /\s+/g,
    " ",
  ).trim(),
  why: section("Why this exists").split("###")[0].trim(),
  how: section("How it works"),
  authors: section("People who made the original images"),
  runningCode: running.match(/```sh\n([\s\S]*?)```/)?.[1],
  running: running.split("```\n")[1]?.split("\n\nRuns created")[0].trim(),
});

export default site;

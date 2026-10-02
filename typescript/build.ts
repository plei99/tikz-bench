import { build } from "esbuild";
import fs from "node:fs";
await build({
  entryPoints: ["src/inspect_pdf.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/inspect_pdf.mjs",
});
fs.copyFileSync(
  "node_modules/mupdf/dist/mupdf-wasm.wasm",
  "dist/mupdf-wasm.wasm",
);

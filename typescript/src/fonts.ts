// Prepare installed METAFONT fonts without executing the submitted document
// outside the TeX sandbox. Only generated PK files are staged into its scratch.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ROOT, fileHash } from "./support.ts";
import { capture, checked, temporary } from "./process.ts";

const pending = new Map<string, Promise<string>>();
export async function prepareMissingFont(
  log: string,
  scratch: string,
  deadline = performance.now() + 60000,
) {
  // TeX can wrap its diagnostic inside either "not" or "found".
  const m = /Font ([A-Za-z][A-Za-z0-9_-]{0,63}) at (\d+) n\s*o\s*t\s+f\s*o\s*u\s*n\s*d/.exec(log);
  if (!m) return false;
  const [, font, size] = m,
    dpi = Number(size);
  if (dpi < 72 || dpi > 2400) return false;
  const remaining = () =>
    Math.max(0.001, (deadline - performance.now()) / 1000);
  const found = await capture(["kpsewhich", font + ".mf"], {
    timeout: Math.min(10, remaining()),
  });
  if (found.returncode || found.error) return false;
  const source = found.stdout.trim();
  if (!source) return false;
  const texRoot = fs.realpathSync(
    (
      await checked(["kpsewhich", "-var-value=TEXMFROOT"], {
        timeout: Math.min(10, remaining()),
      })
    ).trim(),
  );
  const resolved = fs.realpathSync(source);
  if (!resolved.startsWith(texRoot + path.sep)) return false;
  const key = font + "-" + dpi + "-" + fileHash(resolved);
  let prepared = pending.get(key);
  if (!prepared) {
    prepared = (async () => {
      const cache = path.join(ROOT, ".cache/tex-fonts", key);
      const target = path.join(cache, `${font}.${dpi}pk`);
      if (fs.existsSync(target)) return target;
      return temporary("tikz-font-", async (dir) => {
        const dest = path.join(dir, "pk");
        fs.mkdirSync(dest);
        // No submission, user MF source, credentials or host font-cache writes.
        await checked(
          [
            "mktexpk",
            "--dpi",
            String(dpi),
            "--bdpi",
            "600",
            "--mag",
            String(dpi / 600),
            "--mfmode",
            "ljfour",
            "--destdir",
            dest,
            font,
          ],
          {
            cwd: dir,
            env: {
              PATH: process.env.PATH,
              HOME: dir,
              TMPDIR: dir,
              TEXMFHOME: path.join(dir, "empty"),
              TEXMFVAR: path.join(dir, "var"),
            },
            timeout: Math.min(60, remaining()),
          },
        );
        const generated = path.join(dest, `${font}.${dpi}pk`);
        if (!fs.existsSync(generated))
          throw Error("font generation produced no PK file");
        fs.mkdirSync(cache, { recursive: true });
        fs.copyFileSync(generated, target);
        return target;
      });
    })();
    pending.set(key, prepared);
    prepared.catch(() => pending.delete(key));
  }
  const dir = path.join(scratch, "fonts");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(await prepared, path.join(dir, `${font}.${dpi}pk`));
  return true;
}

let unicodeCache: Promise<string> | undefined;
/** Build only the trusted font-name index; submissions write disposable caches. */
export async function prepareUnicodeFonts(
  scratch: string,
  deadline = performance.now() + 60000,
) {
  unicodeCache ??= (async () => {
    const source = (
      await checked(["kpsewhich", "luaotfload.sty"], { timeout: 10 })
    ).trim();
    const userFonts = path.join(os.homedir(), "Library/Fonts");
    const fontStamp = fs.existsSync(userFonts)
      ? fs.statSync(userFonts).mtimeMs
      : 0;
    const cache = path.join(
      ROOT,
      ".cache/tex-fonts",
      "lua-" + fileHash(source) + "-" + fontStamp,
    );
    const names = path.join(cache, "luatex-cache/generic/names");
    if (!fs.existsSync(path.join(names, "luaotfload-names.luc.gz"))) {
      await temporary("tikz-font-index-", async (dir) => {
        if (process.platform === "darwin" && fs.existsSync(userFonts)) {
          fs.mkdirSync(path.join(dir, "Library"));
          fs.symlinkSync(userFonts, path.join(dir, "Library/Fonts"), "dir");
        }
        fs.mkdirSync(cache, { recursive: true });
        await checked(["luaotfload-tool", "--update", "--force"], {
          cwd: dir,
          env: {
            PATH: process.env.PATH,
            HOME: dir,
            TMPDIR: dir,
            TEXMFHOME: path.join(dir, "empty"),
            TEXMFVAR: cache,
            TEXMFCACHE: cache,
          },
          timeout: Math.max(
            0.001,
            Math.min(60, (deadline - performance.now()) / 1000),
          ),
        });
      });
    }
    return names;
  })();
  const names = await unicodeCache;
  fs.cpSync(names, path.join(scratch, "texmf-var/luatex-cache/generic/names"), {
    recursive: true,
  });
}

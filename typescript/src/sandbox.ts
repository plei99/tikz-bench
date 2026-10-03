// OS sandbox for TeX, Poppler and the PDF inspector. There is no unsandboxed
// fallback: macOS uses sandbox-exec and Linux uses bubblewrap.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ROOT } from "./support.ts";
import { checked, which, temporary } from "./process.ts";

/** The only files a sandboxed process may write, inside its scratch directory. */
const OUTPUTS = ["doc.aux", "doc.log", "doc.pdf", "doc.out", "render.png"];
const INSPECTOR = path.join(ROOT, "typescript/dist/inspect_pdf.mjs");
const WASM = path.join(ROOT, "typescript/dist/mupdf-wasm.wasm");
/** Bytes of combined stdout/stderr returned to the caller. */
const OUTPUT_HEAD = 65536;

export function backend() {
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec"))
    return "macos";
  if (process.platform === "linux") {
    which("bwrap");
    return "bubblewrap";
  }
  throw Error("OS sandbox required; unsandboxed TeX is disabled");
}

let paths: Promise<string[]> | undefined;
/** Read-only runtime directories: the TeX tree, the JS runtime and system libraries. */
export function runtimePaths() {
  return (paths ??= (async () => {
    const root = fs.realpathSync(
      (
        await checked(["kpsewhich", "-var-value=TEXMFROOT"], {
          env: { PATH: process.env.PATH },
          timeout: 10,
        })
      ).trim(),
    );
    if (["/", os.homedir(), process.cwd()].includes(root))
      throw Error("invalid TeX runtime root");
    const system =
      process.platform === "darwin"
        ? [
            "/usr/lib",
            "/usr/share",
            "/usr/bin",
            "/bin",
            "/System/Library",
            "/System/Cryptexes",
            "/System/Volumes/Preboot/Cryptexes",
            "/Library/Fonts",
            "/private/var/db/dyld",
            "/private/var/db/timezone",
            "/opt/homebrew/Cellar",
            "/opt/homebrew/opt",
            "/opt/homebrew/lib",
            "/opt/homebrew/share",
            "/opt/homebrew/etc/fonts",
          ]
        : [
            "/usr",
            "/bin",
            "/lib",
            "/lib64",
            "/etc/fonts",
            "/etc/texmf",
            "/var/lib/texmf",
          ];
    // Grant both the link and its target so either spelling resolves.
    return [
      ...new Set(
        [root, path.dirname(which(process.execPath)), ...system]
          .filter((p) => fs.existsSync(p))
          .flatMap((p) => [p, fs.realpathSync(p)]),
      ),
    ].sort();
  })());
}

export const inspectorCommand = (pdf: string, documentOnly = false) => [
  process.execPath,
  INSPECTOR,
  pdf,
  ...(documentOnly ? ["--document"] : []),
];

/** Wrap `command` so it can read runtime paths and `cwd`, and write only OUTPUTS there. */
export async function sandboxCommand(command: string[], cwd: string) {
  const platform = backend(),
    exe = which(command[0]);
  cwd = fs.realpathSync(cwd);
  const reads = [...(await runtimePaths()), cwd],
    writes = OUTPUTS.map((n) => path.join(cwd, n));
  if (platform === "macos") {
    const literal = (p: string) => "(literal " + JSON.stringify(p) + ")",
      subpath = (p: string) => "(subpath " + JSON.stringify(p) + ")";
    const profile = [
      "(version 1)",
      "(deny default)",
      "(allow sysctl-read)",
      "(allow file-read-metadata)",
      '(allow file-read* (literal "/") (literal "/dev/null") (literal "/dev/urandom"))',
      "(allow file-read* " + reads.map(subpath).join(" ") + ")",
      "(allow file-read* " + [INSPECTOR, WASM].map(literal).join(" ") + ")",
      "(allow file-write* " + writes.map(literal).join(" ") + ")",
      "(allow process-exec " + literal(fs.realpathSync(exe)) + ")",
    ].join("\n");
    return ["/usr/bin/sandbox-exec", "-p", profile, exe, ...command.slice(1)];
  }
  // bubblewrap can only bind existing files.
  for (const p of writes) fs.closeSync(fs.openSync(p, "a"));
  return [
    "bwrap",
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    ...[...reads, INSPECTOR, WASM].flatMap((p) => ["--ro-bind", p, p]),
    ...writes.flatMap((p) => ["--bind", p, p]),
    "--chdir",
    cwd,
    "--",
    exe,
    ...command.slice(1),
  ];
}

function readHead(file: string) {
  const fd = fs.openSync(file, "r"),
    b = Buffer.alloc(OUTPUT_HEAD);
  try {
    return b.subarray(0, fs.readSync(fd, b, 0, b.length, 0)).toString();
  } finally {
    fs.closeSync(fd);
  }
}

export type SandboxResult = {
  returncode: number;
  /** First 64 KiB of combined stdout and stderr. */
  stdout: string;
  error?: string;
};
/**
 * Run `command` sandboxed in `cwd` with resource limits. Output goes to the
 * file `outputName` in `cwd` (bounded by the file-size limit), not a pipe.
 */
export async function runSandboxed(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout = 90,
  outputName = "process.stdout",
): Promise<SandboxResult> {
  if (command.includes(INSPECTOR)) {
    // Bun's resolver needs to enumerate the entry point's directory. Stage only
    // the trusted bundle/WASM in scratch; do not grant directory reads in the repo.
    const target = path.join(cwd, "inspect_pdf.mjs");
    fs.copyFileSync(INSPECTOR, target);
    fs.copyFileSync(WASM, path.join(cwd, "mupdf-wasm.wasm"));
    command = command.map((v) => (v === INSPECTOR ? target : v));
  }
  const wrapped = await sandboxCommand(command, cwd),
    outputPath = path.join(cwd, outputName),
    out = fs.openSync(outputPath, "w", 0o600);
  // Static shell launcher outside the sandbox. All variable values are positional
  // arguments, never shell source. bash ulimit -f uses 1024-byte blocks.
  const script =
    'ulimit -c 0; ulimit -n 128; ulimit -f 16384; ulimit -t "$1"; shift; ' +
    (process.platform === "linux" ? "ulimit -v 2097152; " : "") +
    'exec "$@"';
  try {
    return await new Promise<SandboxResult>((resolve, reject) => {
      const p = spawn(
        "/bin/bash",
        [
          "-e",
          "-c",
          script,
          "limit-exec",
          String(Math.ceil(timeout)),
          ...wrapped,
        ],
        {
          cwd,
          env: { ...env, OPENSSL_CONF: "/dev/null" },
          detached: true,
          stdio: ["ignore", out, out],
        },
      );
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-p.pid!, "SIGKILL");
        } catch {}
      }, timeout * 1000);
      p.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          returncode: code ?? -1,
          stdout: readHead(outputPath),
          ...(timedOut ? { error: "process timed out" } : {}),
        });
      });
    });
  } finally {
    fs.closeSync(out);
  }
}

let verified: Promise<void> | undefined;
/** Check once per process that every sandboxed tool starts. */
export function verifySandbox() {
  return (verified ??= temporary("tikz-preflight-", async (dir) => {
    backend();
    for (const p of [INSPECTOR, WASM])
      if (!fs.existsSync(p))
        throw Error(
          "Build the TypeScript inspector first: npm run build-inspector",
        );
    const env = { PATH: process.env.PATH, HOME: dir, TMPDIR: dir };
    for (const [i, cmd] of [
      ["pdflatex", "--version"],
      ["pdftoppm", "-v"],
      inspectorCommand("--version"),
    ].entries()) {
      const r = await runSandboxed(cmd, dir, env, 15, "preflight-" + i);
      if (r.returncode || r.error)
        throw Error("sandbox preflight failed: " + r.stdout.slice(0, 300));
    }
  }));
}

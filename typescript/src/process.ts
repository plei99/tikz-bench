// Child processes with bounded output and wall time.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { MiB } from "./support.ts";

export type ProcessResult = {
  returncode: number;
  stdout: string;
  stderr: string;
  /** Set when the harness stopped the process (timeout or log limit). */
  error?: string;
};
export type CaptureOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  /** Seconds before the whole process group is killed (default 90). */
  timeout?: number;
  /** Bytes allowed on each of stdout and stderr (default 16 MiB). */
  maxLog?: number;
};

/** Run `argv` in its own process group and collect stdout/stderr. */
export function capture(
  argv: string[],
  opts: CaptureOptions = {},
): Promise<ProcessResult> {
  const timeout = opts.timeout ?? 90,
    maxLog = opts.maxLog ?? 16 * MiB;
  return new Promise((resolve, reject) => {
    const p = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const streams = [p.stdout, p.stderr].map((s) => {
      const chunks: Buffer[] = [];
      let length = 0;
      s.on("data", (b: Buffer) => {
        length += b.length;
        if (length > maxLog) stop("CLI log exceeded limit");
        else chunks.push(b);
      });
      return chunks;
    });
    let error: string | undefined;
    function stop(reason: string) {
      error ??= reason;
      try {
        process.kill(-p.pid!, "SIGKILL");
      } catch {
        p.kill("SIGKILL");
      }
    }
    const timer = setTimeout(() => stop("process timed out"), timeout * 1000);
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      const [stdout, stderr] = streams.map((c) => Buffer.concat(c).toString());
      resolve({
        returncode: code ?? -1,
        stdout,
        stderr,
        ...(error ? { error } : {}),
      });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(opts.input ?? "");
  });
}

/** Run `argv` and return stdout; throw on failure without echoing output. */
export async function checked(argv: string[], opts: CaptureOptions = {}) {
  const r = await capture(argv, opts);
  if (r.returncode || r.error)
    throw Error(
      "command failed: " +
        path.basename(argv[0]) +
        (r.error ? " (" + r.error + ")" : ""),
    );
  return r.stdout;
}

/** Resolve an executable on PATH, or verify an absolute one. */
export function which(name: string) {
  const candidates = path.isAbsolute(name)
    ? [name]
    : (process.env.PATH ?? "/usr/bin:/bin")
        .split(path.delimiter)
        .map((dir) => path.resolve(dir, name));
  for (const p of candidates)
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  throw Error("required executable missing: " + name);
}

/** Run `fn` with a fresh private directory that is always removed. */
export async function temporary<T>(
  prefix: string,
  fn: (dir: string) => Promise<T>,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await fn(fs.realpathSync(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

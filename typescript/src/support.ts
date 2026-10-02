import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export type RecordData = Record<string, any>;
export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const DATA = path.join(ROOT, "data");
export const RUNS = path.join(ROOT, "runs");
export const now = () =>
  new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
export const elapsed = (start: number) =>
  Math.round(performance.now() - start) / 1000;
export const readJSON = (p: string): RecordData =>
  JSON.parse(fs.readFileSync(p, "utf8"));
export const fileHash = (p: string) =>
  crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
// Python's canonical JSON spacing is retained for cross-implementation input hashes.
export function canonical(value: any): string {
  if (value === null) return "null";
  if (typeof value === "number" && !Number.isFinite(value))
    throw Error("nonfinite JSON number");
  if (Array.isArray(value)) return "[" + value.map(canonical).join(", ") + "]";
  if (typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ": " + canonical(value[k]))
        .join(", ") +
      "}"
    );
  const result = JSON.stringify(value);
  if (result === undefined) throw Error("undefined JSON value");
  return result;
}
export const fingerprint = (v: any) =>
  crypto.createHash("sha256").update(canonical(v)).digest("hex");
export const same = (a: any, b: any) => canonical(a) === canonical(b);
export function writeJSON(p: string, value: any) {
  canonical(value); // Reject NaN and undefined rather than silently writing null.
  const tmp = path.join(
    path.dirname(p),
    "." + path.basename(p) + "." + crypto.randomUUID() + ".tmp",
  );
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 1) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, p);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
export function safeName(v: string) {
  if (!/^[\p{L}\p{N}_@.\-]+$/u.test(v) || [".", ".."].includes(v))
    throw Error("invalid file or directory name");
  return v;
}
export const configDir = (c: RecordData) =>
  safeName(
    c.model.id.replaceAll("/", "__").replaceAll(":", "_") +
      "@" +
      c.label.replaceAll(" ", "-"),
  );
export function taskRecords(dir: string) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) =>
      fs
        .readdirSync(path.join(dir, e.name))
        .filter((n) => n.endsWith(".json") && !n.endsWith(".judge.json"))
        .map((n) => path.join(dir, e.name, n)),
    )
    .sort();
}
export function agentRunMetadata(dir: string) {
  const meta = readJSON(path.join(dir, "run.json"));
  if (
    meta.track !== "agent" ||
    taskRecords(dir).some((p) => readJSON(p).track !== "agent")
  )
    throw Error(
      "Direct-API or mixed runs are unsupported; create a new agent run",
    );
  return meta;
}
export function manifest(): Record<string, RecordData> {
  return Object.fromEntries(
    fs
      .readFileSync(path.join(DATA, "manifest.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => {
        const r = JSON.parse(l);
        return [r.id, r];
      }),
  );
}
export const subsetFigures = () =>
  readJSON(path.join(DATA, "subset.json"))
    .items.map((i: RecordData) => i.id)
    .sort();
export function checklist(id: string): RecordData[] {
  const reviewed = path.join(DATA, "checklist_reviews", safeName(id) + ".json");
  const items = readJSON(
    fs.existsSync(reviewed)
      ? reviewed
      : path.join(DATA, "checklists", id + ".json"),
  ).checklist.items.filter((i: RecordData) => !i.deleted && i.claim);
  const ids = new Set();
  for (const i of items) {
    if (
      !Number.isSafeInteger(i.id) ||
      ids.has(i.id) ||
      !["core", "detail"].includes(i.weight) ||
      typeof i.claim !== "string" ||
      !i.claim.trim()
    )
      throw Error("invalid checklist item for " + id);
    ids.add(i.id);
  }
  if (!items.length) throw Error("empty checklist for " + id);
  return items;
}
export function readRegular(p: string, max = 1024 * 1024): string {
  const fd = fs.openSync(
    p,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size > max)
      throw Error("submission must be a regular file of at most 1 MiB");
    const b = Buffer.alloc(max + 1);
    let n = 0;
    while (n < b.length) {
      const k = fs.readSync(fd, b, n, b.length - n, null);
      if (!k) break;
      n += k;
    }
    if (n > max) throw Error("file exceeds limit");
    return new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
}
export class Semaphore {
  private busy = 0;
  private waiters: Array<() => void> = [];
  limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy >= this.limit)
      await new Promise<void>((r) => this.waiters.push(r));
    else this.busy++;
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.busy--;
    }
  }
}
export class RateLimiter {
  interval: number;
  next = 0;
  constructor(rpm: number) {
    if (!Number.isFinite(rpm) || rpm <= 0)
      throw Error("requests per minute must be positive and finite");
    this.interval = 60000 / rpm;
  }
  async wait() {
    const n = performance.now(),
      s = Math.max(n, this.next);
    this.next = s + this.interval;
    await new Promise((r) => setTimeout(r, Math.max(0, s - n)));
  }
}
export class Budget {
  limit: number | null;
  spent = 0;
  unknown = 0;
  constructor(limit: number | null) {
    this.limit = limit;
  }
  add(v: number | null) {
    this.spent += v ?? 0;
    this.unknown += +(v === null);
  }
  exhausted() {
    return (
      this.limit !== null && (this.spent >= this.limit || this.unknown > 0)
    );
  }
}
export async function jobs<T>(
  items: Iterable<T>,
  workers: number,
  fn: (i: T) => Promise<void>,
) {
  const it = items[Symbol.iterator]();
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (;;) {
        const next = it.next();
        if (next.done) return;
        await fn(next.value);
      }
    }),
  );
}
export type ProcessResult = {
  returncode: number;
  stdout: string;
  stderr: string;
  error?: string;
};
export async function capture(
  argv: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeout?: number;
    maxLog?: number;
  } = {},
): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const p = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks: Buffer[][] = [[], []],
      length = [0, 0];
    let error: string | undefined;
    const kill = () => {
      try {
        process.kill(-p.pid!, "SIGKILL");
      } catch {
        p.kill("SIGKILL");
      }
    };
    const timer = setTimeout(
      () => {
        error = "process timed out";
        kill();
      },
      (opts.timeout ?? 90) * 1000,
    );
    [p.stdout, p.stderr].forEach((s, i) =>
      s.on("data", (b: Buffer) => {
        length[i] += b.length;
        if (length[i] > (opts.maxLog ?? 16 * 1024 * 1024)) {
          error = "CLI log exceeded limit";
          kill();
        } else chunks[i].push(b);
      }),
    );
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        returncode: code ?? -1,
        stdout: Buffer.concat(chunks[0]).toString(),
        stderr: Buffer.concat(chunks[1]).toString(),
        ...(error ? { error } : {}),
      });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(opts.input ?? "");
  });
}
export async function checked(
  argv: string[],
  opts: Parameters<typeof capture>[1] = {},
) {
  const r = await capture(argv, opts);
  if (r.returncode || r.error)
    throw Error(
      "command failed: " +
        path.basename(argv[0]) +
        (r.error ? " (" + r.error + ")" : ""),
    );
  return r.stdout;
}
export function which(name: string) {
  if (path.isAbsolute(name)) {
    fs.accessSync(name, fs.constants.X_OK);
    return name;
  }
  for (const dir of (process.env.PATH ?? "/usr/bin:/bin").split(
    path.delimiter,
  )) {
    const p = path.resolve(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  throw Error("required executable missing: " + name);
}
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
export const number = (v: any): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

// JSON.parse discards duplicate keys. This scanner rejects duplicates at every depth.
export function strictJSON(text: string): any {
  let i = 0;
  const ws = () => {
    while (/\s/.test(text[i] ?? "") && i < text.length) i++;
  };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i));
    }
    throw Error("unterminated JSON string");
  };
  const value = (): any => {
    ws();
    if (text[i] === '"') return string();
    if (text[i] === "{") {
      i++;
      const out = Object.create(null),
        keys = new Set();
      ws();
      if (text[i] === "}") {
        i++;
        return out;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') throw Error("expected JSON key");
        const k = string();
        if (keys.has(k)) throw Error("duplicate JSON key: " + k);
        keys.add(k);
        ws();
        if (text[i++] !== ":") throw Error("expected colon");
        out[k] = value();
        ws();
        const c = text[i++];
        if (c === "}") return out;
        if (c !== ",") throw Error("expected comma");
      }
    }
    if (text[i] === "[") {
      i++;
      const out: any[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return out;
      }
      for (;;) {
        out.push(value());
        ws();
        const c = text[i++];
        if (c === "]") return out;
        if (c !== ",") throw Error("expected comma");
      }
    }
    const m =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        text.slice(i),
      );
    if (!m) throw Error("invalid JSON");
    i += m[0].length;
    const v = JSON.parse(m[0]);
    if (typeof v === "number" && !Number.isFinite(v))
      throw Error("nonfinite JSON");
    return v;
  };
  const result = value();
  ws();
  if (i !== text.length) throw Error("trailing JSON");
  return result;
}

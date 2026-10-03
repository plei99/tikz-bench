// Paths, timestamps, hashing and JSON/file helpers shared by every module.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

/** Persisted JSON record. Records are versioned on disk, not by these types. */
export type RecordData = Record<string, any>;

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const DATA = path.join(ROOT, "data");
export const RUNS = path.join(ROOT, "runs");
export const MiB = 1024 * 1024;

/** ISO timestamp in Python's `datetime.isoformat()` style (second precision). */
export const now = () =>
  new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
/** Seconds since a `performance.now()` mark, rounded to milliseconds. */
export const elapsed = (start: number) =>
  Math.round(performance.now() - start) / 1000;

/** A finite nonnegative measurement, or null when unknown or invalid. */
export const nonNegative = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
/** Sum of measurements; null if the list is empty or any value is unknown. */
export function sumKnown(values: unknown[]): number | null {
  const known = values.map(nonNegative);
  if (!known.length || known.some((v) => v === null)) return null;
  return known.reduce<number>((s, v) => s + v!, 0);
}
/** Python's round(): halves go to the nearest even integer. */
export function roundEven(v: number) {
  const f = Math.floor(v);
  return v - f === 0.5 ? (f % 2 ? f + 1 : f) : Math.round(v);
}
/** Bounded error text for persisted records. */
export const errorText = (e: unknown) => String(e).slice(0, 500);

export const sha256 = (data: string | Buffer) =>
  crypto.createHash("sha256").update(data).digest("hex");
export const fileHash = (p: string) => sha256(fs.readFileSync(p));

/**
 * Python's `json.dumps(sort_keys=True)` spacing. Input hashes depend on this
 * exact text, so any change invalidates every saved run and grade.
 */
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
export const fingerprint = (v: unknown) => sha256(canonical(v));
export const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
/** True when `v` is an object whose keys are exactly `keys`. */
export const hasExactKeys = (v: unknown, keys: string[]) =>
  !!v && typeof v === "object" && same(Object.keys(v).sort(), [...keys].sort());

export const readJSON = (p: string): RecordData =>
  JSON.parse(fs.readFileSync(p, "utf8"));
export const readJSONIfExists = (p: string): RecordData | null =>
  fs.existsSync(p) ? readJSON(p) : null;

/** Atomically replace `p`; an interrupted write leaves the old record intact. */
export function writeJSON(p: string, value: unknown) {
  canonical(value); // JSON.stringify would silently write NaN/undefined as null.
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

/** Reject path separators and traversal in names used as path components. */
export function safeName(v: string) {
  if (!/^[\p{L}\p{N}_@.\-]+$/u.test(v) || v === "." || v === "..")
    throw Error("invalid file or directory name");
  return v;
}

/** Read a regular UTF-8 file without following links or blocking on FIFOs. */
export function readRegular(p: string, max = MiB): string {
  const fd = fs.openSync(
    p,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.size > max)
      throw Error("submission must be a regular file of at most 1 MiB");
    // Read one byte past the limit: the file may grow after fstat.
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

/** Replace each secret, longest first so overlapping secrets cannot leak. */
export function redact(
  text: string,
  secrets: Iterable<string>,
  marker: string,
) {
  for (const secret of [...new Set(secrets)].sort(
    (a, b) => b.length - a.length,
  ))
    if (secret) text = text.replaceAll(secret, marker);
  return text;
}

/**
 * JSON.parse silently keeps the last of duplicate keys, which would let a judge
 * reply carry two different verdicts. This parser rejects duplicates at every
 * depth, non-JSON whitespace and nonfinite numbers.
 */
export function strictJSON(text: string): any {
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
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
  const sequence = (close: string, item: () => void) => {
    i++;
    ws();
    if (text[i] === close) {
      i++;
      return;
    }
    for (;;) {
      item();
      ws();
      const c = text[i++];
      if (c === close) return;
      if (c !== ",") throw Error("expected comma");
    }
  };
  const value = (): any => {
    ws();
    if (text[i] === '"') return string();
    if (text[i] === "{") {
      const out = Object.create(null);
      sequence("}", () => {
        ws();
        if (text[i] !== '"') throw Error("expected JSON key");
        const k = string();
        if (k in out) throw Error("duplicate JSON key: " + k);
        ws();
        if (text[i++] !== ":") throw Error("expected colon");
        out[k] = value();
      });
      return out;
    }
    if (text[i] === "[") {
      const out: any[] = [];
      sequence("]", () => out.push(value()));
      return out;
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

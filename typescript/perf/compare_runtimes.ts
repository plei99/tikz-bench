// Interleave equivalent workloads across Node, Bun and Deno; retain raw samples
// and runtime provenance. Run from typescript/:
//
//   bun perf/compare_runtimes.ts [--samples 7] [--out results/runtime-comparison.json]
//
// No model service calls. The 4:1 mix reflects the current 80/20 task
// categories, not agent solve latency. A runtime must pass the correctness
// tests before selection. Each worker runs typescript/perf/worker.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { ROOT, sha256 } from "../src/support.ts";

const TS = path.join(ROOT, "typescript");
const SEED = 20261002;
const WORKLOADS = [
  "accounting",
  "report",
  "prepare",
  "compile",
  "visual",
  "mix",
];

function options(argv: string[]) {
  const out = {
    samples: 7,
    out: path.join(TS, "results/runtime-comparison.json"),
  };
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i + 1];
    if (argv[i] === "--samples" && value) {
      out.samples = Number(value);
      if (!Number.isSafeInteger(out.samples) || out.samples < 1)
        throw Error("--samples must be a positive integer");
      i++;
    } else if (argv[i] === "--out" && value) {
      out.out = path.resolve(value);
      i++;
    } else throw Error("usage: compare_runtimes.ts [--samples N] [--out FILE]");
  }
  return out;
}

/**
 * mulberry32: a small, documented 32-bit seeded PRNG. The retired Python
 * driver used random.Random(20261002); its order cannot be reproduced here,
 * so the interleaving differs from earlier Python-driven results while the
 * method (seeded, recorded, shuffled per sample) is unchanged.
 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** In-place Fisher–Yates shuffle, the same algorithm as Python's shuffle. */
function shuffle<T>(items: T[], random: () => number) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b),
    m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** A persistent JSON-lines worker process. */
class Worker {
  private buffer = "";
  private lines: string[] = [];
  private waiting: ((line: string | null) => void) | null = null;
  private stderr = "";
  private closed = false;
  readonly name: string;
  readonly process: ChildProcessWithoutNullStreams;
  constructor(name: string, command: string[]) {
    this.name = name;
    this.process = spawn(command[0], command.slice(1), {
      cwd: TS,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let i;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        this.lines.push(this.buffer.slice(0, i));
        this.buffer = this.buffer.slice(i + 1);
      }
      this.flush();
    });
    this.process.stderr.on("data", (b) => {
      this.stderr = (this.stderr + b).slice(-2000);
    });
    this.process.on("close", () => {
      this.closed = true;
      this.flush();
    });
    this.process.on("error", (e) => {
      this.stderr += String(e);
      this.closed = true;
      this.flush();
    });
  }
  private flush() {
    if (!this.waiting) return;
    if (this.lines.length) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(this.lines.shift()!);
    } else if (this.closed) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(null);
    }
  }
  /** The next stdout line; an error if the worker has exited. */
  async readLine(what: string) {
    const line = await new Promise<string | null>((resolve) => {
      this.waiting = resolve;
      this.flush();
    });
    if (line === null)
      throw Error(`${this.name} ${what}: ${this.stderr.slice(0, 500)}`);
    return line;
  }
  async request(workload: string) {
    this.process.stdin.write(JSON.stringify({ workload }) + "\n");
    const start = performance.now(),
      line = await this.readLine(workload + " worker exited"),
      driver = (performance.now() - start) / 1000,
      reply = JSON.parse(line);
    if (!reply.ok)
      throw Error(
        `${this.name}/${workload} failed correctness: ${JSON.stringify(reply)}`,
      );
    return {
      seconds: reply.seconds as number,
      driver_seconds: driver,
      result: reply.result,
    };
  }
  async stop() {
    if (this.closed) return;
    const exited = new Promise((r) => this.process.once("close", r));
    this.process.stdin.end();
    this.process.kill("SIGTERM");
    const timer = setTimeout(() => this.process.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }
}

/** Hashes of every file whose behaviour the measurements depend on. */
function sourceHashes() {
  const hashes: Record<string, string> = {};
  for (const folder of ["typescript/src", "typescript/perf"]) {
    const dir = path.join(ROOT, folder);
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      if (name.endsWith(".ts") && fs.lstatSync(p).isFile())
        hashes[folder + "/" + name] = sha256(fs.readFileSync(p));
    }
  }
  const helpers = "typescript/tests/helpers.ts";
  hashes[helpers] = sha256(fs.readFileSync(path.join(ROOT, helpers)));
  return hashes;
}

function cpu() {
  if (process.platform === "darwin") {
    const r = spawnSync("sysctl", ["-n", "machdep.cpu.brand_string"], {
      encoding: "utf8",
    });
    if (r.status === 0) return r.stdout.trim();
  }
  return os.cpus()[0]?.model ?? "unknown";
}

async function main() {
  const args = options(process.argv.slice(2)),
    worker = path.join(TS, "perf/worker.ts");
  const commands: Record<string, string[]> = {
    node: ["node", worker],
    bun: ["bun", worker],
    deno: ["deno", "run", "-A", worker],
  };
  const names = Object.keys(commands),
    random = mulberry32(SEED),
    workers: Record<string, Worker> = {},
    versions: Record<string, unknown> = {},
    samples: Record<
      string,
      Record<string, Record<string, unknown>[]>
    > = Object.fromEntries(names.map((n) => [n, {}]));
  try {
    for (const name of names) {
      workers[name] = new Worker(name, commands[name]);
      versions[name] = JSON.parse(
        await workers[name].readLine("failed startup"),
      );
    }
    for (const workload of WORKLOADS) {
      console.log("Warmup: " + workload);
      for (const name of names) {
        await workers[name].request(workload);
        samples[name][workload] = [];
      }
      for (let i = 0; i < args.samples; i++)
        for (const name of shuffle([...names], random)) {
          const value = await workers[name].request(workload);
          samples[name][workload].push(value);
          console.log(
            `${workload} ${i + 1}/${args.samples} ${name}: ${value.seconds.toFixed(4)}s`,
          );
        }
    }
  } finally {
    await Promise.all(Object.values(workers).map((w) => w.stop()));
  }
  // Time fresh CLI processes separately: help is not a benchmark workload.
  for (const name of names) {
    const cmd = [...commands[name].slice(0, -1), path.join(TS, "src/cli.ts")];
    const values = [];
    for (let i = 0; i < args.samples; i++) {
      const start = performance.now(),
        r = spawnSync(cmd[0], [...cmd.slice(1), "--help"], {
          cwd: TS,
          stdio: ["ignore", "ignore", "pipe"],
          timeout: 15000,
        });
      if (r.status !== 0)
        throw Error(`${name} --help failed: ${String(r.stderr).slice(0, 500)}`);
      values.push({ seconds: (performance.now() - start) / 1000 });
    }
    samples[name].cli_startup = values;
  }

  const summary: Record<string, Record<string, unknown>> = {};
  for (const [name, groups] of Object.entries(samples)) {
    summary[name] = {};
    for (const [workload, values] of Object.entries(groups)) {
      const seconds = values.map((v) => v.seconds as number);
      summary[name][workload] = {
        median_seconds: median(seconds),
        min_seconds: Math.min(...seconds),
        max_seconds: Math.max(...seconds),
        samples: seconds.length,
      };
    }
  }
  const mix = (n: string) => (summary[n].mix as any).median_seconds as number;
  const result = {
    platform: `${os.type()} ${os.release()} (${process.platform})`,
    machine: os.machine(),
    cpu: cpu(),
    created_utc: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    seed: SEED,
    prng: "mulberry32 seeded with `seed`; Fisher–Yates shuffle of the runtime order for every sample",
    method:
      "One warmup per workload/runtime; seven interleaved samples by default; persistent workers; real TeX/Poppler/OS sandbox; no model calls. Fresh help startup is measured separately.",
    mix: "Five sequential preparations/full-document compilations/extracted-figure renders; four deterministic panel replays and one exact visual comparison. Excludes model and Docker execution latency.",
    driver: { runtime: process.versions, argv: process.argv.slice(2) },
    versions,
    summary,
    raw: samples,
    source_sha256: sourceHashes(),
    fastest_mix: names.reduce((a, b) => (mix(b) < mix(a) ? b : a)),
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(summary, null, 2));
  console.log("Fastest mixed workload: " + result.fastest_mix);
}

await main();

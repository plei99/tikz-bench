"""Interleave equivalent workloads; retain raw samples and runtime provenance.

No model service calls. The 4:1 mix reflects the current 80/20 task categories,
not agent solve latency. A runtime must pass correctness tests before selection.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import random
import statistics
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
TS = ROOT / "typescript"
parser = argparse.ArgumentParser()
parser.add_argument("--samples", type=int, default=7)
parser.add_argument("--out", type=Path, default=TS / "results/runtime-comparison.json")
args = parser.parse_args()
commands = {"python": [str(ROOT / ".venv/bin/python"), str(TS / "perf/worker.py")],
            "node": ["node", str(TS / "perf/worker.ts")], "bun": ["bun", str(TS / "perf/worker.ts")],
            "deno": ["deno", "run", "-A", str(TS / "perf/worker.ts")]}
workers, versions = {}, {}
samples = {name: {} for name in commands}
rng = random.Random(20261002)
workloads = ["accounting", "report", "prepare", "compile", "visual", "mix"]
try:
    for name, cmd in commands.items():
        p = subprocess.Popen(cmd, cwd=TS, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        workers[name] = p
        line = p.stdout.readline()
        if not line:
            raise RuntimeError(f"{name} failed startup: {p.stderr.read()[:500]}")
        versions[name] = json.loads(line)
    def run(name, workload):
        p = workers[name]
        p.stdin.write(json.dumps({"workload": workload}) + "\n")
        p.stdin.flush()
        start = time.perf_counter()
        line = p.stdout.readline()
        if not line:
            raise RuntimeError(f"{name}/{workload} worker exited: {p.stderr.read()[:500]}")
        reply = json.loads(line)
        if not reply["ok"]:
            raise RuntimeError(f"{name}/{workload} failed correctness: {reply}")
        return {"seconds": reply["seconds"], "driver_seconds": time.perf_counter()-start, "result": reply["result"]}
    for workload in workloads:
        print(f"Warmup: {workload}", flush=True)
        for name in commands:
            run(name, workload)
            samples[name][workload] = []
        for i in range(args.samples):
            order = list(commands)
            rng.shuffle(order)
            for name in order:
                value = run(name, workload)
                samples[name][workload].append(value)
                print(f"{workload} {i+1}/{args.samples} {name}: {value['seconds']:.4f}s", flush=True)
    # Time fresh CLI processes separately: help is not a benchmark workload.
    for name in commands:
        cmd = ([str(ROOT / ".venv/bin/python"), str(ROOT / "scripts/agent_bench.py")] if name == "python" else
               [*commands[name][:-1], str(TS / "src/cli.ts")]) + ["--help"]
        values = []
        for _ in range(args.samples):
            start = time.perf_counter()
            subprocess.run(cmd, cwd=TS, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True, timeout=15)
            values.append({"seconds": time.perf_counter()-start})
        samples[name]["cli_startup"] = values
finally:
    for p in workers.values():
        p.terminate()
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.kill()

summary = {}
for name, groups in samples.items():
    summary[name] = {}
    for workload, values in groups.items():
        seconds = sorted(v["seconds"] for v in values)
        summary[name][workload] = {"median_seconds": statistics.median(seconds), "min_seconds": min(seconds),
                                   "max_seconds": max(seconds), "samples": len(seconds)}
hashes = {}
for folder in [ROOT / "scripts", TS / "src"]:
    for p in sorted(folder.glob("*")):
        if p.suffix in {".py", ".ts"} and not p.is_symlink():
            hashes[str(p.relative_to(ROOT))] = hashlib.sha256(p.read_bytes()).hexdigest()
result = {"platform": platform.platform(), "machine": platform.machine(), "cpu": subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip() if sys.platform == "darwin" else platform.processor(),
          "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "seed": 20261002,
          "method": "One warmup per workload/runtime; seven interleaved samples by default; persistent workers; real TeX/Poppler/OS sandbox; no model calls. Fresh help startup is measured separately.",
          "mix": "Five sequential preparations/full-document compilations/extracted-figure renders; four deterministic panel replays and one exact visual comparison. Excludes model and Docker execution latency.",
          "versions": versions, "summary": summary, "raw": samples, "source_sha256": hashes,
          "fastest_mix": min(summary, key=lambda n: summary[n]["mix"]["median_seconds"])}
args.out.parent.mkdir(parents=True, exist_ok=True)
args.out.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(summary, indent=2))
print("Fastest mixed workload:", result["fastest_mix"])

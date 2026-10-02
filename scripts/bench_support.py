"""Local persistence and scheduling helpers for the benchmark harness."""

import hashlib
import json
import math
import os
import tempfile
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path


class RateLimiter:
    """Space out request starts across worker threads."""

    def __init__(self, per_minute):
        if per_minute <= 0 or not math.isfinite(per_minute):
            raise ValueError("requests per minute must be positive and finite")
        self.interval = 60.0 / per_minute
        self.lock = threading.Lock()
        self.next_start = 0.0

    def wait(self):
        with self.lock:
            now = time.monotonic()
            start = max(now, self.next_start)
            self.next_start = start + self.interval
        time.sleep(max(0.0, start - now))


def write_json(path, obj):
    """Replace a record atomically; interruption leaves the previous record intact."""
    path = Path(path)
    text = json.dumps(obj, indent=1, ensure_ascii=False, allow_nan=False) + "\n"
    name = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         prefix=f".{path.name}.", suffix=".tmp", delete=False) as f:
            name = f.name
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
    finally:
        if name is not None:
            Path(name).unlink(missing_ok=True)


def fingerprint(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False,
                                     allow_nan=False).encode()).hexdigest()


def file_hash(path):
    with open(path, "rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def completed_jobs(function, jobs, workers):
    """Yield (job, future), keeping at most `workers` jobs in flight.

    Unscheduled jobs remain in the caller's iterator, so budget checks and resume
    decisions can happen without queuing thousands of futures.
    """
    jobs = iter(jobs)
    with ThreadPoolExecutor(workers) as pool:
        pending = {}

        def fill():
            while len(pending) < workers:
                job = next(jobs, None)
                if job is None:
                    break
                pending[pool.submit(function, *job)] = job

        fill()
        while pending:
            done, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                yield pending.pop(future), future
            fill()

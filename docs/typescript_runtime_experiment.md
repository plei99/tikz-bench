# TypeScript runtime experiment, 2 October 2026

Bun 1.4.2 was selected on `experiment/typescript-runtime` and then adopted as the
default on `main`. The mixed local
workload took a median 8.42 seconds under Bun, compared with 9.63 seconds under
Python: 12.6% less elapsed time. The `./benchmark` launcher uses Bun.
The Python implementation remains available for existing runs and regression
comparisons.

The port covers the complete benchmark runtime: task preparation, all seven agent
adapters, subscription authentication, compilation and extraction, PDF inspection,
both grading methods, recovery, usage accounting, and reports. Dataset curation
and the review website remain local Python tooling. They are outside the benchmark
runtime described in `AGENTS.md`.

## Measurements

The comparison ran on an Apple M4 Pro with macOS 26.6.2, using Python 3.14.7, Node 26.10.0,
Bun 1.4.2 and Deno 2.9.7. Each workload had one warmup and seven measured samples
per runtime. Runtime order was shuffled within each round with a fixed seed.
Workers stayed alive between samples; fresh CLI startup was measured separately.
The table shows median elapsed seconds.

| Workload | Python | Node | Bun | Deno |
|---|---:|---:|---:|---:|
| Five-task mix, 4 checklist / 1 digital | 9.631 | 9.591 | **8.422** | 9.905 |
| Complete document + extracted figure compilation/rendering | 1.536 | 1.234 | **1.132** | 1.341 |
| Digital comparison, including diagnostic PNGs | **1.252** | 2.857 | 1.709 | 2.580 |
| Private Git repository + normalized reference image | **0.279** | 0.498 | 0.370 | 0.441 |
| Report exports, 200 planned task rows | 0.026 | 0.027 | **0.014** | 0.028 |
| Parse 14,000 CLI accounting records | 0.114 | 0.033 | **0.022** | 0.036 |
| Fresh CLI help process | 0.316 | 0.091 | **0.013** | 0.028 |

Bun had the lowest mixed-workload time in all seven rounds. Its range was
8.195–8.647 seconds; Python's was 9.342–9.990 seconds. Some individual preparation
and compilation trials had substantial variation, so those medians should not be
read as precise forecasts for another machine.

The mixed workload follows the shortlist's 80% handwritten / 20% digital split.
It creates five private task repositories, compiles five complete notes documents
and their extracted figures, replays four panel aggregations, and performs one
digital comparison. Compilation uses a fixed TikZ fixture. Digital comparison uses
a recovered paper figure rendered at 200 and 300 dpi. This measures local processing
with controlled inputs; it does not measure agent problem-solving or subscription
judge latency. No model calls were made.

Python remains faster for raster comparison alone. Bun's lower compilation overhead
made it faster for the tested task mix. A workload dominated by digital regrading
could favor Python. The experiment does not establish how much faster a complete
remote-agent benchmark run would be.

The [raw results](../typescript/results/runtime-comparison.json) retain every sample,
runtime versions and source hashes. The driver is
[`compare_runtimes.py`](../typescript/perf/compare_runtimes.py); it invokes the
unchanged Python implementation and the TypeScript port with equivalent inputs.

## Correctness and isolation

The differential fixtures cover 14 realistic CLI transcripts, report fields for
200 planned rows, full-document extraction, and 19 image comparisons. The visual
cases include missing arrows, changed labels/colors/fills, extra instructions,
stretching, rotation, reflection, blank output, and five recovered TikZ originals
rendered at different resolutions. All pass/fail decisions agree with Python.
The Lanczos upsampling/downsampling fixtures also match Pillow pixel for pixel.

All 65 TypeScript tests pass under each of Node, Bun and Deno, and all 162 tests
in the existing Python suite pass. The TypeScript suite exercises actual
TeX compilation and sandbox denials, PDF raster/annotation rejection, response
hashes, panel disagreements and resume, subscription-only authentication, and
the external prepare/submit/judge/report workflow. Fake local CLIs test model
selection and image transport without accessing paid services. TypeScript type
checking and the Prettier check pass as well.

The TypeScript comparator retains the policy thresholds but has its own
`raster_exact_ts_v1` signature. Floating-point reductions differ between JavaScript
and NumPy/SciPy. Fixture agreement is evidence of compatibility, not a proof that
every image near a threshold will receive the same result. Saved Python digital
grades therefore require regrading under the new implementation.

PDF inspection uses [MuPDF's JavaScript device interface](https://mupdf.readthedocs.io/en/1.27.0/reference/javascript/types/Page.html)
inside the same OS isolation boundary as TeX and Poppler. Only a bundled inspector
and its WASM file are staged into scratch. The sandbox receives no benchmark data,
user files or credentials. File-size, CPU, descriptor and wall-time limits remain.
Bun needed its entry point staged into scratch because its module resolver reads
the containing directory; granting access to the checkout was unnecessary.

Docker is unavailable on this machine, so actual Docker execution was not tested.
The adapter flags and container boundaries are covered by offline tests. Linux
bubblewrap execution still needs validation on Linux; failures stop execution
without an unsandboxed fallback. Dependency audit reports no known vulnerabilities
in the installed lockfile.

See the [TypeScript instructions](../typescript/README.md) for setup and reproduction.
Use a fresh run name for TypeScript generation. Existing Python runs can continue
with their original CLIs; this experiment leaves their files intact.

# Benchmark website

This Lume site uses a public snapshot of aggregate results. All prose on the
page (introduction, "Why this exists," "How it works," runner instructions and
author credits) is extracted from the repository's README at build time.

The site is built in English (`/`) and Chinese (`/zh/`) from one template.
Chinese prose comes from `README.zh.md`, whose section headings must match the
`sections` strings in `src/lib/i18n.js`; the build fails otherwise. Interface
text for both languages is in `src/lib/i18n.js`, and tests check that the two
dictionaries have the same keys. A first visit from a Chinese-language browser
is redirected to `/zh/` unless the visitor has chosen a language with the header
switch.

```sh
cd website
deno task serve                 # http://localhost:3000
deno task check
deno task test
deno task build
deno task verify
```

Lume 3.3.2 is pinned in `deno.json`; dependencies are pinned in `deno.lock`. The
build needs Deno 2 and network access on the first build, but needs no Bun, TeX
installation, model credentials, or private benchmark data.

The chart and leaderboard are rendered into the HTML at build time. JavaScript
adds the score category and chart metric switches, sorting, best/every effort
views, harness/provider/model filters, run selection, run details, and a saved
light/dark theme. Unfinished runs and pilots are not shown.

## Refreshing real results

From the repository root, export the private benchmark records:

```sh
./benchmark export
cd website
deno task refresh
deno task build
deno task verify
```

`refresh` reads `../runs/web-results/results.json` by default; an alternate
export can be supplied as `deno task refresh /path/to/results.json`. It
explicitly selects aggregate fields and writes `src/data/results.json`. It never
copies reference images, selected figure IDs, task records, checklists, judge
replies, or logs. Review the aggregate snapshot diff and commit it with the
website source when updating the public site. The full exporter bundle must
remain under the gitignored `runs/` directory.

The local grading service also runs `bun runs/grading-watch/website-updater.ts`.
It checks completed score reports every 30 seconds. When a report is added or
revised, it exports current results, refreshes the aggregate snapshot, builds
the website, and verifies the output. Failed updates retry automatically. Its
status and build log live in `runs/grading-watch/website-updater-status.json`
and `website-build.log`. The updater keeps the local website current; GitHub
Pages still follows the deployment workflow below.

## GitHub Pages

The repository workflow builds and validates the site on relevant pushes and
PRs. Once the repository is public, set **Settings → Pages → Source → GitHub
Actions** and run the **Website** workflow (or push a website change to `main`).
Deployment is deliberately disabled while the repository is private.

The workflow builds for the repository's project URL. For a custom domain,
change the workflow's `--location` to that domain and configure it in Pages
settings. Local builds can verify any base path:

```sh
deno task build --location=https://plei99.github.io/tikz-bench/
deno task verify
```

`website/_site/` is the only deployment artifact. The public snapshot is checked
in so GitHub Actions never needs the private overlay, evaluation assets, or run
directories. No synthetic benchmark results are included.

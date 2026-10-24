# Benchmark website

The site is written as React components and rendered to static HTML by
[Bun Bake](https://bun.com) (`bun build --app`), the same stack as
[plei99.github.io](https://github.com/plei99/plei99.github.io). No React reaches
the browser: the pages have no client components, so the output is plain HTML,
the stylesheet and one bundled script. Everything that is code is TypeScript and
type checked, including the browser script.

It shows a public snapshot of aggregate results. All prose on the page
(introduction, "Why this exists," "How it works," runner instructions and author
credits) is extracted from the repository's README at build time.

The site is built in English (`/`) and Chinese (`/zh/`) from one component.
Chinese prose comes from `README.zh.md`, whose section headings must match the
`sections` strings in `lib/i18n.ts`; the build fails otherwise. Interface text
for both languages is in `lib/i18n.ts`, typed so that both dictionaries have the
same keys. A first visit from a Chinese-language browser is redirected to `/zh/`
unless the visitor has chosen a language with the header switch.

## Running it

Bake is experimental and only in Bun's canary builds (developed against
1.4.4-canary.1). Put a canary `bun` first on your `PATH`, since package scripts
call `bun` again, then run `bun install`.

```sh
cd website
bun run dev      # build, serve dist/ at http://localhost:3000, rebuild on save
bun run check    # dprint check, oxlint, bun check (pages and browser code)
bun run test
bun run build    # bun build --app, then scripts/finish.ts; writes dist/
bun run verify
```

The build needs no TeX installation, model credentials, or private benchmark
data.

## Layout

```
bun.app.ts          Bake config: the built-in React framework
pages/              index.tsx is /, zh/index.tsx is /zh/
components/Page.tsx The page: head, header, leaderboard, README prose, dialogs
lib/
  model.ts          Snapshot types, ranking, filters, axes, the Pareto frontier
  render.ts         Chart and table HTML, shared by the build and the browser
  i18n.ts           Interface strings for en + zh
  logos.ts          Model and harness marks (sources in LOGOS.md)
  site.ts           Validated snapshot, base-path URLs, README sections
  inline.ts         Builds client/inline/*.ts into the scripts inlined in <head>
  security.ts       Hash-based script policy and integrity-checked module loader
client/
  app.ts            Controls: re-renders chart and table, filters, dialogs, theme
  inline/           Head scripts: theme before first paint, language detection
data/results.json   The public aggregate snapshot
public/             Copied verbatim: styles.css, favicon.svg, .nojekyll
scripts/
  finish.ts         After Bake: <html> attributes, bundles js/app.js, asset hashes
  serve.ts          The dev server
  refresh.ts        Reduces a private export to data/results.json
  validate.ts       The snapshot's allowlisted schema
  verify.ts         Checks dist/ for unexpected files and broken local links
```

The chart and leaderboard are rendered into the HTML at build time. JavaScript
adds the score category and chart metric switches, sorting, best/every effort
views, harness/provider/developer-country/model filters, run selection, run
details, and a saved light/dark theme. Unfinished runs and pilots are not shown.

The leaderboard shows SVG model/company marks and pi/OpenCode harness marks.
Asset sources and licenses are recorded in `LOGOS.md`. Country identifies the
model developer, independently of the serving provider or harness.

## Browser security

Every generated page starts with a hash-based Content Security Policy. Hashed
loaders start only the compiled app module, with Subresource Integrity. Only the
page's own inline scripts (`lib/inline.ts`) are hashed: any other script in the
generated HTML fails the build instead of being authorized. Injected scripts,
inline event handlers, `javascript:` URLs, `eval`, embedded documents, form
submissions and external resource requests are blocked. The chart's inline style
attributes remain allowed; inline style blocks are blocked.

The embedded results stay a JSON data block, and the browser validates the same
public schema as the build before rendering them. Labels are escaped when used
in HTML. Regression tests run through `bun run test`. The Pages artifact still
contains only the allowlisted public files; no private benchmark data is needed
for these checks.

## Refreshing real results

From the repository root, export the private benchmark records:

```sh
./benchmark export
cd website
bun run refresh
bun run build
bun run verify
```

`refresh` reads `../runs/web-results/results.json` by default; an alternate
export can be supplied as `bun run refresh /path/to/results.json`. It explicitly
selects aggregate fields and writes `data/results.json`. It never copies
reference images, selected figure IDs, task records, checklists, judge replies,
or logs. Review the aggregate snapshot diff and commit it with the website
source when updating the public site. The full exporter bundle must remain under
the gitignored `runs/` directory.

The October 22 refresh includes archived generation attempts for the DeepSeek
1017 and Mistral runs, plus recovered OpenRouter billing metadata for Mistral
pi. Mistral costs remain lower bounds because some interrupted requests have no
recoverable billing ID. Their `cost_sources` contains `lower_bound`, rendered as
`≥` in tables, tooltips and details. Preserve that accounting when refreshing;
the raw benchmark export alone omits archived attempts and reconciliation.

The local grading service also runs `bun runs/grading-watch/website-updater.ts`.
It checks completed score reports every 30 seconds. When a report is added or
revised, it exports current results, refreshes the aggregate snapshot, builds
the website, and verifies the output. Failed updates retry automatically. Its
status and build log live in `runs/grading-watch/website-updater-status.json`
and `website-build.log`. The updater keeps the local website current; GitHub
Pages still follows the deployment workflow below.

## GitHub Pages

The repository workflow builds and validates the site on relevant pushes and
PRs. The public repository uses **Settings → Pages → Source → GitHub Actions**.
Run the **Website** workflow or push a website change to `main` to deploy.
Deployment is disabled if the repository is made private.

The workflow builds for the repository's project URL by setting `SITE_URL`. For
a custom domain, change the workflow's `SITE_URL` to that domain and configure
it in Pages settings. Local builds can verify any base path:

```sh
SITE_URL=https://plei99.github.io/tikz-bench/ bun run build
bun run verify
```

`website/dist/` is the only deployment artifact. The public snapshot is checked
in so GitHub Actions never needs the private overlay, evaluation assets, or run
directories. No synthetic benchmark results are included.

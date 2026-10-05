# Chinese version of the tikz-bench website

Approved October 5, 2026.

## Goal

Chinese-speaking readers can read the whole results site in Chinese, with the
same leaderboard, chart and controls as the English site. The repository README
gains a full Chinese translation that the site reads its prose from, just as the
English site reads `README.md`.

## Pages and language switching

- English stays at `/tikz-bench/`; Chinese is at `/tikz-bench/zh/`. Both are
  built from one template in `website/src/index.page.ts`, which yields one page
  per language.
- `<html lang>` is `en` or `zh-CN`. Each page declares `hreflang` alternates
  (`en`, `zh-Hans`) for both pages, using absolute URLs.
- The header has a link to the other language, labelled in that language
  ("中文" on the English page, "en" on the Chinese page), as on plei99.github.io.
  Following it keeps the current `#fragment` and stores the choice in
  `localStorage` (`tikz-lang`).
- On the English page, a first visit (no stored choice, no same-site referrer)
  from a browser whose language starts with `zh` is redirected to `/zh/`.
- The theme setting and every chart/table control work the same on both pages.

## Text

- Interface strings live in `website/src/lib/i18n.js` as `strings.en` and
  `strings.zh` with identical keys. Text built from several pieces (run counts,
  theme toggle, detail rows, the credit line) is a whole-sentence function per
  language.
- `render.js`, `model.js` and `app.js` read the language from the state
  (`state.lang`), so the same strings serve the build and the browser. `app.js`
  takes the language from `<html lang>`.
- Formatting: dates `October 5, 2026` / `2026年10月5日`; durations
  `9.1 min`, `45 s` / `9.1 分钟`, `45 秒`. Dollars, percentages and the `k` token
  suffix are unchanged.
- Unchanged in both languages: model, agent and effort identifiers (except
  `default`, which is `默认`), shell commands, people's names, the canary notice.
- "Digital" figures are 电脑绘制 (computer-drawn); hand-drawn figures are 手绘.

## Prose

- `README.zh.md` is a full translation of `README.md`, written in the author's
  first-person voice. The two READMEs link to each other above the canary line.
- `website/_config.ts` reads both READMEs. Section headings come from the same
  `i18n.js` strings the page uses for its `<h2>`s, so a missing or renamed
  section fails the build.
- Extraction is structural, not English-specific: the intro is the first
  paragraph after the canary line; the run note is the first paragraph after the
  code block in the running section.

## Fonts and layout

- `--sans` adds `"PingFang SC"`, `"Microsoft YaHei"` and `"Noto Sans CJK SC"`
  before the generic family, so Chinese renders predictably. No webfonts or
  subsetting are needed.
- Chart label placement counts CJK characters as double width.

## Checks

- Tests: the two dictionaries have the same keys; the Chinese chart and table
  contain no English interface strings.
- `scripts/verify.ts` checks `index.html` and `zh/index.html`: links, import map,
  embedded data and every ranked configuration.
- The build fails if `README.zh.md` lacks a section the site uses.

## Out of scope

Chinese versions of `docs/`, the agent benchmark guide, `AGENTS.md` and
`typescript/README.md` (links to them say they are in English), and any
automated translation step.

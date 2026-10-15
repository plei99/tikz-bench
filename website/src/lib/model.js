import { text } from "./i18n.js";

// Display labels for each metric are in i18n.js.
export const metrics = {
  cost: { key: "cost" },
  output_tokens: { key: "output_tokens" },
  agent_seconds: {
    key: "agent_seconds",
    // Ticks fall on whole minutes.
    unit: 60,
    // The runner stops an agent after an hour (`--timeout 3600`) and scores
    // the task 0, so no average can exceed it.
    limit: 3600,
  },
};

export const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const percent = (n) => n == null ? "—" : `${(n * 100).toFixed(1)}%`;
export const money = (n) => n == null ? "—" : `$${n.toFixed(2)}`;
export const tokens = (n) =>
  n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
export const duration = (n, lang = "en") =>
  n == null
    ? "—"
    : n >= 60
    ? text(lang).minutes((n / 60).toFixed(1))
    : text(lang).seconds(Math.round(n));
export const metricValue = (config, metric, category = "overall") =>
  config[
    category === "overall"
      ? metric
      : `${category === "taste" ? "handwritten" : category}_${metric}`
  ] ?? null;
export const formatScore = (n, category) =>
  category === "taste"
    ? n == null ? "—" : `${(n * 10).toFixed(1)}/10`
    : percent(n);
export const formatMetric = (n, metric, lang = "en") =>
  ({ cost: money, output_tokens: tokens, agent_seconds: duration })[metric](
    n,
    lang,
  );
export const effortName = (c, lang = "en") =>
  c.model === "mimo-v2.6-pro" ? "on" : c.effort ?? text(lang).defaultEffort;

// Provider-published names, verified 2026-10-16. Keep saved model IDs for
// filtering and series identity; harness aliases and effort aren't model names.
const modelNames = {
  // https://www.anthropic.com/claude-opus-5-5
  // https://www.anthropic.com/claude-haiku-5-5
  // https://www.anthropic.com/claude-sonnet-5-5
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-haiku-5-5": "Claude Haiku 5.5",
  "claude-sonnet-5-5-low": "Claude Sonnet 5.5",
  // https://developers.openai.com/api/docs/models
  "gpt-6-astra": "GPT-6 Astra",
  "gpt-6-luna": "GPT-6 Luna",
  "gpt-6.1-sol": "GPT-6.1 Sol",
  // https://www.deepseek.com/en/news/deepseek-v4-1-flash/
  "deepseek-v4.1-flash": "DeepSeek-V4.1-Flash",
  // https://ai.google.dev/gemini-api/docs/models/gemini-4-argon
  "gemini-4-argon": "Gemini 4 Argon",
  // https://autoclaw.z.ai/blog/model/glm-5.3-flash/
  "glm-5.3-flash": "GLM-5.3-Flash",
  // https://www.kimi.com/ai-models/kimi-k3
  "k3": "Kimi K3",
  // https://mimo.mi.com/models/en-US/mimo-v2.6-pro
  "mimo-v2.6-pro": "MiMo-V2.6-Pro",
};
export const modelName = (model) => modelNames[model] ?? model;
export const configName = (c, lang = "en") =>
  `${modelName(c.model)} [${effortName(c, lang)}] · ${c.agent}`;

// Every model from one lab shares the lab's colour (--lab-* in styles.css);
// the chart's direct labels tell its series apart.
export const color = (config) => `var(--lab-${provider(config)})`;

// Marker shape identifies the agent harness; a vendor's own CLI is a circle.
const shapes = {
  opencode: "square",
  pi: "triangle",
  cursor: "diamond",
  antigravity: "diamond",
};
export const shape = (config) => shapes[config.agent] ?? "circle";

// The company behind each model, from its name. Display names are in i18n.js;
// tests fail if a recorded model matches none of these.
/** @type {[RegExp, string][]} */
const providers = [
  [/^(gpt|o\d)/, "openai"],
  [/^(claude|haiku|sonnet|opus)/, "anthropic"],
  [/^(k\d|kimi)/, "moonshot"],
  [/^glm/, "zai"],
  [/^mimo/, "xiaomi"],
  [/^(muse|llama)/, "meta"],
  [/^gemini/, "google"],
  [/^deepseek/, "deepseek"],
  [/^qwen/, "alibaba"],
];
export const provider = (config) =>
  providers.find(([pattern]) => pattern.test(config.model))?.[1] ?? "other";

// Country of the model developer, independent of the serving provider or CLI.
const developerCountries = {
  openai: "us",
  anthropic: "us",
  meta: "us",
  google: "us",
  moonshot: "cn",
  zai: "cn",
  xiaomi: "cn",
  deepseek: "cn",
  alibaba: "cn",
};
export const country = (config) =>
  developerCountries[provider(config)] ?? "other";

// Filterable properties of a run. Selected values in one facet are
// alternatives; facets combine, and an empty facet does not filter.
export const facets = {
  agent: (c) => c.agent,
  provider,
  country,
  model: (c) => c.model,
};
export const matchesFilters = (config, filters = {}) =>
  Object.entries(filters).every(([facet, values]) =>
    !values.length || values.includes(facets[facet](config))
  );

// The values each facet takes among a subset's completed runs.
export function facetValues(data, cohort) {
  const runs = data.configurations.filter((c) =>
    c.complete && !c.pilot && c.cohort_id === cohort
  );
  return Object.fromEntries(
    Object.entries(facets).map((
      [facet, value],
    ) => [facet, [...new Set(runs.map(value))].sort()]),
  );
}

export function initialState(data, lang = "en") {
  const cohort =
    data.cohorts.find((c) =>
      data.configurations.some((r) =>
        r.cohort_id === c.id && r.complete && r.model === "gpt-6.1-sol" &&
        r.effort === "xhigh"
      )
    ) ?? data.cohorts[0];
  return {
    lang,
    cohort: cohort?.id,
    metric: "cost",
    category: "overall",
    efforts: "all",
    scale: "log",
    frontier: false,
    filters: { agent: [], provider: [], country: [], model: [] },
    sort: "score",
    ascending: false,
    selected: data.configurations.filter((c) => c.complete).map((c) => c.id),
  };
}

export function scoreValue(config, category) {
  if (category === "taste") {
    return config.taste_score == null ? null : config.taste_score / 10;
  }
  return config[category === "overall" ? "score" : `${category}_score`];
}

export function ranked(data, state) {
  let rows = data.configurations.filter((c) =>
    c.complete && !c.pilot &&
    c.cohort_id === state.cohort && state.selected.includes(c.id) &&
    matchesFilters(c, state.filters) &&
    scoreValue(c, state.category) !== null
  );
  if (state.efforts === "best") {
    const best = new Map();
    for (const c of rows) {
      const key = `${c.model}/${c.agent}`;
      const old = best.get(key);
      if (
        !old ||
        scoreValue(c, state.category) > scoreValue(old, state.category) ||
        (scoreValue(c, state.category) === scoreValue(old, state.category) &&
          (metricValue(c, "cost", state.category) ?? Infinity) <
            (metricValue(old, "cost", state.category) ?? Infinity))
      ) best.set(key, c);
    }
    rows = [...best.values()];
  }
  return rows.sort((a, b) => {
    const av = state.sort === "score"
      ? scoreValue(a, state.category)
      : metricValue(a, state.sort, state.category);
    const bv = state.sort === "score"
      ? scoreValue(b, state.category)
      : metricValue(b, state.sort, state.category);
    if (av == null && bv == null) return a.id.localeCompare(b.id);
    if (av == null) return 1;
    if (bv == null) return -1;
    const result = typeof av === "string" ? av.localeCompare(bv) : av - bv;
    return (state.ascending ? result : -result) || a.id.localeCompare(b.id);
  });
}

// Ticks are 1, 2 and 5 times powers of ten in the given unit. With a fixed
// maximum the axis ends there, and ticks too close to it are dropped.
export function logAxis(values, unit = 1, fixedMax) {
  const positive = values.filter((v) => Number.isFinite(v) && v > 0);
  const low = positive.length ? Math.min(...positive) / 1.2 : 0.1;
  const high = fixedMax ??
    (positive.length ? Math.max(...positive) * 1.2 : 10);
  const candidates = [];
  for (
    let exponent = Math.floor(Math.log10(low / unit));
    exponent <= Math.ceil(Math.log10(high / unit));
    exponent++
  ) {
    for (const multiplier of [1, 2, 5]) {
      candidates.push(multiplier * 10 ** exponent * unit);
    }
  }
  const min = candidates.filter((v) => v <= low).at(-1) ?? low;
  const max = fixedMax ?? candidates.find((v) => v >= high) ?? high;
  const position = (v) =>
    (Math.log10(v) - Math.log10(min)) / (Math.log10(max) - Math.log10(min));
  const ticks = [
    ...candidates.filter((v) =>
      v >= min && (fixedMax ? position(v) < 0.9 : v <= max)
    ),
    ...(fixedMax ? [fixedMax] : []),
  ];
  const stride = Math.max(1, Math.ceil((ticks.length - 1) / 7));
  return {
    min,
    max,
    ticks: ticks.filter((_, i) => i % stride === 0 || i === ticks.length - 1),
    position,
  };
}

// Linear score axis zoomed to the plotted range, in whole 5% steps.
export function scoreAxis(values) {
  const finite = values.filter(Number.isFinite);
  const low = finite.length ? Math.min(...finite) : 0;
  const high = finite.length ? Math.max(...finite) : 1;
  let min = Math.max(0, Math.floor((low - 0.01) * 20) / 20);
  let max = Math.min(1, Math.ceil((high + 0.01) * 20) / 20);
  while (max - min < 0.2 - 1e-9) {
    if (max < 1) max = Math.round((max + 0.05) * 20) / 20;
    if (max - min < 0.2 - 1e-9 && min > 0) {
      min = Math.round((min - 0.05) * 20) / 20;
    }
  }
  const step = max - min <= 0.4 ? 0.05 : 0.1;
  const ticks = [];
  for (let i = 0; min + i * step <= max + 1e-9; i++) {
    ticks.push(Math.round((min + i * step) * 100) / 100);
  }
  return { min, max, ticks, position: (v) => (v - min) / (max - min) };
}

// Linear axis from zero with 1-2-5 steps (in multiples of unit) and at most
// six intervals.
export function linearAxis(values, unit = 1, fixedMax) {
  const positive = values.filter((v) => Number.isFinite(v) && v > 0);
  const high = fixedMax != null
    ? fixedMax / unit
    : (positive.length ? Math.max(...positive) : 10) * 1.05 / unit;
  const magnitude = 10 ** Math.floor(Math.log10(high / 6));
  const step =
    [1, 2, 5, 10].map((m) => m * magnitude).find((s) => high / s <= 6) * unit;
  const max = Math.ceil(high * unit / step) * step;
  const ticks = Array.from(
    { length: Math.round(max / step) + 1 },
    (_, i) => i * step,
  );
  return { min: 0, max, ticks, position: (v) => v / max };
}

// Configurations no other point beats on both axes: none is cheaper (or
// faster) with an equal or higher score. Returned in increasing metric order.
export function paretoFrontier(points, metric, category) {
  const sorted = [...points].sort((a, b) =>
    metricValue(a, metric, category) - metricValue(b, metric, category) ||
    scoreValue(b, category) - scoreValue(a, category)
  );
  const frontier = [];
  for (const c of sorted) {
    if (
      !frontier.length ||
      scoreValue(c, category) > scoreValue(frontier.at(-1), category)
    ) frontier.push(c);
  }
  return frontier;
}

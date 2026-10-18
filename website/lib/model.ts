import { type Lang, text } from "./i18n";

/** The public snapshot in data/results.json (checked by scripts/validate.ts). */
export type Snapshot = {
  schema_version: number;
  generated_at: string;
  benchmark: string;
  cohorts: Cohort[];
  configurations: Configuration[];
};
export type Cohort = {
  id: string;
  name: string;
  tasks: number;
  handwritten: number;
  digital: number;
};
export type Configuration = {
  id: string;
  cohort_id: string;
  run: string;
  model: string;
  agent: string;
  effort: string | null;
  label: string;
  complete: boolean;
  pilot: boolean;
  planned: number;
  scored: number;
  generated: number;
  score: number | null;
  taste_score: number | null;
  cost: number | null;
  output_tokens: number | null;
  agent_seconds: number | null;
  api_seconds: number | null;
  compile_rate: number | null;
  cost_sources: string[];
  handwritten_cost: number | null;
  digital_cost: number | null;
  handwritten_agent_seconds: number | null;
  digital_agent_seconds: number | null;
  handwritten_api_seconds: number | null;
  digital_api_seconds: number | null;
  handwritten_output_tokens: number | null;
  digital_output_tokens: number | null;
  handwritten_score: number | null;
  digital_score: number | null;
  handwritten_perfect: number | null;
  digital_perfect: number | null;
};

export type Category = "overall" | "handwritten" | "taste" | "digital";
export type Metric = "cost" | "output_tokens" | "agent_seconds";
export type Facet = "agent" | "provider" | "country" | "model";
export type State = {
  lang: Lang;
  cohort: string | undefined;
  metric: Metric;
  category: Category;
  efforts: "all" | "best";
  scale: "log" | "linear";
  frontier: boolean;
  filters: Record<Facet, string[]>;
  sort: "score" | Metric;
  ascending: boolean;
  selected: string[];
};

// Display labels for each metric are in i18n.ts.
export const metrics: Record<Metric, { unit?: number; limit?: number }> = {
  cost: {},
  output_tokens: {},
  agent_seconds: {
    // Ticks fall on whole minutes.
    unit: 60,
    // The runner stops an agent after an hour (`--timeout 3600`) and scores
    // the task 0, so no average can exceed it.
    limit: 3600,
  },
};

const entities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export const escape = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => entities[c]!);
export const percent = (n: number | null) =>
  n == null ? "—" : `${(n * 100).toFixed(1)}%`;
export const money = (n: number | null) => n == null ? "—" : `$${n.toFixed(2)}`;
export const tokens = (n: number | null) =>
  n == null ? "—" : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
export const duration = (n: number | null, lang: Lang = "en") =>
  n == null
    ? "—"
    : n >= 60
    ? text(lang).minutes((n / 60).toFixed(1))
    : text(lang).seconds(Math.round(n));
export const metricValue = (
  config: Configuration,
  metric: Metric | "api_seconds",
  category: Category = "overall",
): number | null =>
  config[
    category === "overall"
      ? metric
      : `${category === "taste" ? "handwritten" : category}_${metric}` as const
  ] ?? null;
export const formatScore = (n: number | null, category: Category) =>
  category === "taste"
    ? n == null ? "—" : `${(n * 10).toFixed(1)}/10`
    : percent(n);
export const formatMetric = (
  n: number | null,
  metric: Metric,
  lang: Lang = "en",
) =>
  metric === "cost"
    ? money(n)
    : metric === "output_tokens"
    ? tokens(n)
    : duration(n, lang);
export const effortName = (
  c: Pick<Configuration, "model" | "effort">,
  lang: Lang = "en",
) => c.model === "mimo-v2.6-pro" ? "on" : c.effort ?? text(lang).defaultEffort;

// Provider-published names, verified 2026-10-16. Keep saved model IDs for
// filtering and series identity; harness aliases and effort aren't model names.
const modelNames: Record<string, string> = {
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
export const modelName = (model: string) => modelNames[model] ?? model;
export const configName = (c: Configuration, lang: Lang = "en") =>
  `${modelName(c.model)} (${effortName(c, lang)}), ${c.agent}`;

// Every model from one lab shares the lab's colour (--lab-* in styles.css);
// the chart's direct labels tell its series apart.
export const color = (config: Pick<Configuration, "model">) =>
  `var(--lab-${provider(config)})`;

// Marker shape identifies the agent harness; a vendor's own CLI is a circle.
export type Shape = "circle" | "square" | "triangle" | "diamond";
const shapes: Record<string, Shape> = {
  opencode: "square",
  pi: "triangle",
  cursor: "diamond",
  antigravity: "diamond",
};
export const shape = (config: Configuration) =>
  shapes[config.agent] ?? "circle";

// The company behind each model, from its name. Display names are in i18n.ts;
// tests fail if a recorded model matches none of these.
export type Provider =
  | "openai"
  | "anthropic"
  | "moonshot"
  | "zai"
  | "xiaomi"
  | "meta"
  | "google"
  | "deepseek"
  | "alibaba"
  | "other";
const providers: [RegExp, Provider][] = [
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
export const provider = (config: Pick<Configuration, "model">): Provider =>
  providers.find(([pattern]) => pattern.test(config.model))?.[1] ?? "other";

// Country of the model developer, independent of the serving provider or CLI.
export type Country = "us" | "cn" | "other";
const developerCountries: Partial<Record<Provider, Country>> = {
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
export const country = (config: Pick<Configuration, "model">): Country =>
  developerCountries[provider(config)] ?? "other";

// Filterable properties of a run. Selected values in one facet are
// alternatives; facets combine, and an empty facet does not filter.
export const facets: Record<Facet, (c: Configuration) => string> = {
  agent: (c) => c.agent,
  provider,
  country,
  model: (c) => c.model,
};
export const matchesFilters = (
  config: Configuration,
  filters: Partial<Record<Facet, string[]>> = {},
) =>
  (Object.entries(filters) as [Facet, string[]][]).every(([facet, values]) =>
    !values.length || values.includes(facets[facet](config))
  );

// The values each facet takes among a subset's completed runs.
export function facetValues(data: Snapshot, cohort: string | undefined) {
  const runs = data.configurations.filter((c) =>
    c.complete && !c.pilot && c.cohort_id === cohort
  );
  return Object.fromEntries(
    (Object.entries(facets) as [Facet, (c: Configuration) => string][]).map((
      [facet, value],
    ) => [facet, [...new Set(runs.map(value))].sort()]),
  ) as Record<Facet, string[]>;
}

// Runs left out of the default selection. They stay listed in the run
// selection dialog, where a reader can turn them back on.
const hiddenByDefault: [agent: string, model: string][] = [
  ["pi", "deepseek-v4.1-flash"],
  ["pi", "glm-5.3-flash"],
  ["opencode", "mimo-v2.6-pro"],
];
export const shownByDefault = (config: Configuration) =>
  !hiddenByDefault.some(([agent, model]) =>
    config.agent === agent && config.model === model
  );

export function initialState(data: Snapshot, lang: Lang = "en"): State {
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
    selected: data.configurations.filter((c) => c.complete && shownByDefault(c))
      .map((c) => c.id),
  };
}

export function scoreValue(config: Configuration, category: Category) {
  if (category === "taste") {
    return config.taste_score == null ? null : config.taste_score / 10;
  }
  return config[
    category === "overall" ? "score" : `${category}_score` as const
  ];
}

export function ranked(data: Snapshot, state: State) {
  let rows = data.configurations.filter((c) =>
    c.complete && !c.pilot &&
    c.cohort_id === state.cohort && state.selected.includes(c.id) &&
    matchesFilters(c, state.filters) &&
    scoreValue(c, state.category) !== null
  );
  if (state.efforts === "best") {
    const best = new Map<string, Configuration>();
    for (const c of rows) {
      const key = `${c.model}/${c.agent}`;
      const old = best.get(key);
      const score = scoreValue(c, state.category)!;
      if (
        !old ||
        score > scoreValue(old, state.category)! ||
        (score === scoreValue(old, state.category) &&
          (metricValue(c, "cost", state.category) ?? Infinity) <
            (metricValue(old, "cost", state.category) ?? Infinity))
      ) best.set(key, c);
    }
    rows = [...best.values()];
  }
  const value = (c: Configuration) =>
    state.sort === "score"
      ? scoreValue(c, state.category)
      : metricValue(c, state.sort, state.category);
  return rows.sort((a, b) => {
    const av = value(a), bv = value(b);
    if (av == null && bv == null) return a.id.localeCompare(b.id);
    if (av == null) return 1;
    if (bv == null) return -1;
    const result = av - bv;
    return (state.ascending ? result : -result) || a.id.localeCompare(b.id);
  });
}

export type Axis = {
  min: number;
  max: number;
  ticks: number[];
  position: (v: number) => number;
};

// Ticks are 1, 2 and 5 times powers of ten in the given unit. With a fixed
// maximum the axis ends there, and ticks too close to it are dropped.
export function logAxis(values: number[], unit = 1, fixedMax?: number): Axis {
  const positive = values.filter((v) => Number.isFinite(v) && v > 0);
  const low = positive.length ? Math.min(...positive) / 1.2 : 0.1;
  const high = fixedMax ??
    (positive.length ? Math.max(...positive) * 1.2 : 10);
  const candidates: number[] = [];
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
  const position = (v: number) =>
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
export function scoreAxis(values: (number | null)[]): Axis {
  const finite = values.filter((v): v is number => Number.isFinite(v));
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
export function linearAxis(
  values: number[],
  unit = 1,
  fixedMax?: number,
): Axis {
  const positive = values.filter((v) => Number.isFinite(v) && v > 0);
  const high = fixedMax != null
    ? fixedMax / unit
    : (positive.length ? Math.max(...positive) : 10) * 1.05 / unit;
  const magnitude = 10 ** Math.floor(Math.log10(high / 6));
  const step =
    [1, 2, 5, 10].map((m) => m * magnitude).find((s) => high / s <= 6)! * unit;
  const max = Math.ceil(high * unit / step) * step;
  const ticks = Array.from(
    { length: Math.round(max / step) + 1 },
    (_, i) => i * step,
  );
  return { min: 0, max, ticks, position: (v) => v / max };
}

// Configurations no other point beats on both axes: none is cheaper (or
// faster) with an equal or higher score. Returned in increasing metric order.
export function paretoFrontier(
  points: Configuration[],
  metric: Metric,
  category: Category,
) {
  const sorted = [...points].sort((a, b) =>
    metricValue(a, metric, category)! - metricValue(b, metric, category)! ||
    scoreValue(b, category)! - scoreValue(a, category)!
  );
  const frontier: Configuration[] = [];
  for (const c of sorted) {
    if (
      !frontier.length ||
      scoreValue(c, category)! > scoreValue(frontier.at(-1)!, category)!
    ) frontier.push(c);
  }
  return frontier;
}

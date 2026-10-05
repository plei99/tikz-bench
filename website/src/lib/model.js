import { text } from "./i18n.js";

// Display labels for each metric are in i18n.js.
export const metrics = {
  cost: { key: "cost" },
  output_tokens: { key: "output_tokens" },
  agent_seconds: {
    key: "agent_seconds",
    // Linear ticks fall on whole minutes.
    unit: 60,
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
export const metricValue = (config, metric) => config[metrics[metric].key];
export const formatMetric = (n, metric, lang = "en") =>
  ({ cost: money, output_tokens: tokens, agent_seconds: duration })[metric](
    n,
    lang,
  );
export const effortName = (c, lang = "en") =>
  c.effort ?? text(lang).defaultEffort;
export const configName = (c, lang = "en") =>
  `${c.model} [${effortName(c, lang)}] · ${c.agent}`;

// Categorical slots (--series-N in styles.css) in fixed order. The first three
// stay distinguishable for every pair, as a scatter plot needs; known models are
// pinned so a filter never repaints them.
const pinned = [["sol", 1], ["opus", 2], ["astra", 3]];

export function color(config) {
  const slot = pinned.find(([name]) => config.model.includes(name))?.[1];
  if (slot) return `var(--series-${slot})`;
  let hash = 0;
  for (const c of config.model) {
    hash = (Math.imul(hash, 31) + c.charCodeAt(0)) | 0;
  }
  return `var(--series-${4 + Math.abs(hash) % 5})`;
}

// Marker shape identifies the agent harness; a vendor's own CLI is a circle.
const shapes = {
  opencode: "square",
  pi: "triangle",
  cursor: "diamond",
  antigravity: "diamond",
};
export const shape = (config) => shapes[config.agent] ?? "circle";

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
    sort: "score",
    ascending: false,
    selected: data.configurations.filter((c) => c.complete).map((c) => c.id),
  };
}

export function scoreValue(config, category) {
  return config[category === "overall" ? "score" : `${category}_score`];
}

export function ranked(data, state) {
  let rows = data.configurations.filter((c) =>
    c.complete && !c.pilot &&
    c.cohort_id === state.cohort && state.selected.includes(c.id) &&
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
          (c.cost ?? Infinity) < (old.cost ?? Infinity))
      ) best.set(key, c);
    }
    rows = [...best.values()];
  }
  return rows.sort((a, b) => {
    const av = state.sort === "score"
      ? scoreValue(a, state.category)
      : a[state.sort];
    const bv = state.sort === "score"
      ? scoreValue(b, state.category)
      : b[state.sort];
    if (av == null && bv == null) return a.id.localeCompare(b.id);
    if (av == null) return 1;
    if (bv == null) return -1;
    const result = typeof av === "string" ? av.localeCompare(bv) : av - bv;
    return (state.ascending ? result : -result) || a.id.localeCompare(b.id);
  });
}

export function logAxis(values) {
  const positive = values.filter((v) => Number.isFinite(v) && v > 0);
  const low = positive.length ? Math.min(...positive) / 1.2 : 0.1;
  const high = positive.length ? Math.max(...positive) * 1.2 : 10;
  const candidates = [];
  for (
    let exponent = Math.floor(Math.log10(low));
    exponent <= Math.ceil(Math.log10(high));
    exponent++
  ) {
    for (const multiplier of [1, 2, 5]) {
      candidates.push(multiplier * 10 ** exponent);
    }
  }
  const min = candidates.filter((v) => v <= low).at(-1) ?? low;
  const max = candidates.find((v) => v >= high) ?? high;
  const ticks = candidates.filter((v) => v >= min && v <= max);
  const stride = Math.max(1, Math.ceil((ticks.length - 1) / 7));
  return {
    min,
    max,
    ticks: ticks.filter((_, i) => i % stride === 0 || i === ticks.length - 1),
    position: (v) =>
      (Math.log10(v) - Math.log10(min)) / (Math.log10(max) - Math.log10(min)),
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
export function linearAxis(values, unit = 1) {
  const positive = values.filter((v) => Number.isFinite(v) && v > 0);
  const high = (positive.length ? Math.max(...positive) : 10) * 1.05 / unit;
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
    metricValue(a, metric) - metricValue(b, metric) ||
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

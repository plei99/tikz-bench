import results from "../src/data/results.json" with { type: "json" };
import {
  duration,
  effortName,
  facetValues,
  initialState,
  linearAxis,
  logAxis,
  metrics,
  metricValue,
  paretoFrontier,
  provider,
  ranked,
  scoreValue,
} from "../src/lib/model.js";
import { chart, table } from "../src/lib/render.js";
import { strings } from "../src/lib/i18n.js";
import { validateSnapshot } from "../scripts/validate.ts";

type Configuration = typeof results.configurations[number];

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

Deno.test("public snapshot contains only allowlisted aggregates", () => {
  validateSnapshot(results);
  const serialized = JSON.stringify(results);
  for (
    const field of [
      "figure_ids",
      "checklist",
      "reference_image",
      "rendering",
      "panel_reviews",
      "prompt_sha256",
      "stored_score",
    ]
  ) {
    assert(!serialized.includes(`"${field}"`), `Private field found: ${field}`);
  }
});

Deno.test("real Sol xhigh and both Astra efforts are in the first chart and table", () => {
  const state = initialState(results);
  const rows = ranked(results, state);
  for (
    const [model, effort] of [
      ["gpt-6.1-sol", "xhigh"],
      ["gpt-6-astra", "max"],
      ["gpt-6-astra", "high"],
    ]
  ) {
    const row = rows.find((c: Configuration) =>
      c.model === model && c.effort === effort && c.agent === "codex"
    );
    assert(row, `Initial chart missing ${model} ${effort}`);
    assert(row.planned === 100 && row.scored === 100);
    assert(chart(results, state).includes(`data-config="${row.id}"`));
    assert(table(results, state).includes(`data-config="${row.id}"`));
  }
});

Deno.test("incomplete runs and completed pilots cannot enter rankings", () => {
  const state = {
    ...initialState(results),
    efforts: "all",
    selected: results.configurations.map((c) => c.id),
  };
  assert(results.configurations.some((c) => !c.complete));
  for (const row of ranked(results, state)) {
    assert(row.complete && !row.pilot && row.score !== null);
    assert(row.scored === row.planned);
  }
});

Deno.test("sorting and category views use the recorded measurements", () => {
  const state = { ...initialState(results), efforts: "all" };
  const scoreOrder = ranked(results, state);
  assert(
    scoreOrder.every((c: Configuration, i: number) =>
      i === 0 || c.score! <= scoreOrder[i - 1].score
    ),
  );
  const costOrder = ranked(results, {
    ...state,
    sort: "cost",
    ascending: true,
  });
  assert(costOrder[0].model === "gpt-6.1-sol");
  for (const category of ["handwritten", "digital"]) {
    const rows = ranked(results, { ...state, category });
    assert(rows.length >= 2);
    for (const row of rows) {
      assert(scoreValue(row, category) === row[`${category}_score`]);
    }
  }
});

Deno.test("deselection gives an honest empty state and axes include every real point", () => {
  const state = initialState(results);
  const empty = { ...state, selected: [] };
  assert(ranked(results, empty).length === 0);
  assert(chart(results, empty).includes("No configurations to plot"));
  assert(
    table(results, empty).includes("No completed configurations selected"),
  );
  for (const metric of ["cost", "output_tokens", "agent_seconds"]) {
    const values = ranked(results, state).map((c: Configuration) =>
      c[metric as "cost" | "output_tokens" | "agent_seconds"]
    );
    const axis = logAxis(values);
    assert(axis.min > 0 && axis.min < Math.min(...values));
    assert(axis.max > Math.max(...values));
    for (const value of values) {
      assert(axis.position(value) > 0 && axis.position(value) < 1);
    }
    // Equal multiplicative changes must occupy equal horizontal distances.
    const first = values[0];
    assert(
      Math.abs(
        (axis.position(first * 2) - axis.position(first)) -
          (axis.position(first * 4) - axis.position(first * 2)),
      ) < 1e-12,
    );
    assert(axis.ticks.every((v: number) => v > 0));
    assert(chart(results, { ...state, metric }).includes("(log scale)"));
    assert(!chart(results, { ...state, metric }).includes("NaN"));
  }
});

Deno.test("linear scale starts at zero and covers every real point", () => {
  const state = { ...initialState(results), scale: "linear" };
  for (const metric of ["cost", "output_tokens", "agent_seconds"] as const) {
    const values = ranked(results, state).map((c: Configuration) => c[metric]);
    const axis = linearAxis(
      values,
      (metrics[metric] as { unit?: number }).unit,
    );
    assert(axis.min === 0 && axis.ticks[0] === 0);
    assert(axis.max > Math.max(...values) && axis.ticks.at(-1) === axis.max);
    assert(axis.ticks.length >= 3 && axis.ticks.length <= 7);
    if (metric === "agent_seconds") {
      assert(axis.ticks.every((v: number) => v % 60 === 0));
    }
    const svg = chart(results, { ...state, metric });
    assert(!svg.includes("(log scale)") && !svg.includes("NaN"));
  }
});

Deno.test("Pareto frontier keeps exactly the undominated configurations", () => {
  const state = initialState(results);
  for (const category of ["overall", "handwritten", "digital"]) {
    for (const metric of ["cost", "output_tokens", "agent_seconds"]) {
      const rows = ranked(results, { ...state, category });
      const frontier = paretoFrontier(rows, metric, category);
      const dominated = (c: Configuration) =>
        rows.some((o: Configuration) =>
          o !== c &&
          metricValue(o, metric) <= metricValue(c, metric) &&
          scoreValue(o, category) >= scoreValue(c, category) &&
          (metricValue(o, metric) < metricValue(c, metric) ||
            scoreValue(o, category) > scoreValue(c, category))
        );
      for (const c of rows) {
        assert(frontier.includes(c) === !dominated(c), `${c.id} ${metric}`);
      }
    }
  }
  assert(!chart(results, state).includes('class="pareto"'));
  const shown = chart(results, { ...state, frontier: true });
  assert(shown.includes('class="pareto"') && shown.includes("Pareto frontier"));
});

// Every key path in a dictionary, marking which entries are functions.
function shape(value: unknown, prefix = ""): string[] {
  if (typeof value === "function") return [`${prefix}()`];
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) =>
      shape(v, prefix ? `${prefix}.${k}` : k)
    ).sort();
  }
  return [prefix];
}

// Every fixed English string, e.g. "Pareto frontier".
function leaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(leaves);
  }
  return [];
}

Deno.test("English and Chinese dictionaries have the same keys", () => {
  const en = shape(strings.en), zh = shape(strings.zh);
  assert(
    JSON.stringify(en) === JSON.stringify(zh),
    `Keys differ: ${[
      ...en.filter((k) => !zh.includes(k)),
      ...zh.filter((k) => !en.includes(k)),
    ]}`,
  );
});

Deno.test("Chinese chart and table contain no English interface text", () => {
  const state = initialState(results, "zh");
  const html = [
    chart(results, { ...state, frontier: true }),
    chart(results, { ...state, scale: "linear", metric: "agent_seconds" }),
    chart(results, { ...state, category: "digital" }),
    table(results, state),
    table(results, { ...state, selected: [] }),
    chart(results, { ...state, selected: [] }),
  ].join("\n");
  for (const english of leaves(strings.en)) {
    // Short words such as "Run" or "Log" are too likely to occur in data.
    if (english.length < 4 || leaves(strings.zh).includes(english)) continue;
    assert(!html.includes(english), `English text in Chinese page: ${english}`);
  }
  assert(html.includes("（对数刻度）") && html.includes("帕累托前沿"));
  assert(html.includes("分钟") && !html.includes(" min<"));
});

Deno.test("Chinese formatting uses Chinese units and effort names", () => {
  assert(duration(90, "zh") === "1.5 分钟" && duration(45, "zh") === "45 秒");
  assert(duration(90) === "1.5 min" && duration(45) === "45 s");
  assert(effortName({ effort: null }, "zh") === "默认");
  assert(effortName({ effort: "xhigh" }, "zh") === "xhigh");
  assert(strings.zh.date("2026-10-05T01:00:00Z") === "2026年10月5日");
});

Deno.test("every recorded model belongs to a known provider", () => {
  for (const c of results.configurations) {
    assert(provider(c) !== "other", `No provider for model ${c.model}`);
    assert(provider(c) in strings.en.providers);
  }
});

Deno.test("filters combine alternatives within a facet and facets together", () => {
  const state = initialState(results);
  const all = ranked(results, state);
  const by = (filters: Record<string, string[]>) =>
    ranked(results, {
      ...state,
      filters: { agent: [], provider: [], model: [], ...filters },
    });
  assert(by({}).length === all.length);
  const codex = by({ agent: ["codex"] });
  assert(
    codex.length && codex.every((c: Configuration) => c.agent === "codex"),
  );
  const either = by({ agent: ["codex", "pi"] });
  assert(
    either.length ===
      all.filter((c: Configuration) => ["codex", "pi"].includes(c.agent))
        .length,
  );
  const openaiPi = by({ provider: ["openai"], agent: ["pi"] });
  assert(
    openaiPi.length &&
      openaiPi.every((c: Configuration) =>
        c.agent === "pi" && provider(c) === "openai"
      ),
  );
  assert(by({ provider: ["anthropic"], agent: ["codex"] }).length === 0);
  // The chart, table and "Best" view all show only filtered runs.
  const filters = { agent: [], provider: [], model: ["gpt-6.1-sol"] };
  for (const efforts of ["all", "best"]) {
    const view = { ...state, efforts, filters };
    const html = chart(results, view) + table(results, view);
    for (const c of all) {
      assert(
        html.includes(`data-config="${c.id}"`) ===
          ranked(results, view).includes(c),
        `${efforts}: ${c.id}`,
      );
    }
  }
});

Deno.test("filter options come only from completed runs", () => {
  const state = initialState(results);
  const values = facetValues(results, state.cohort);
  const completed = ranked(results, state);
  assert(
    JSON.stringify(values.agent) ===
      JSON.stringify(
        [...new Set(completed.map((c: Configuration) => c.agent))].sort(),
      ),
  );
  assert(!values.model.includes("mimo-v2.6-pro"));
  assert(values.provider.every((p: string) => p in strings.zh.providers));
});

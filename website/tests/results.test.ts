import { test } from "bun:test";
import snapshot from "../data/results.json" with { type: "json" };
import {
  color,
  configName,
  country,
  duration,
  effortName,
  facetValues,
  formatScore,
  initialState,
  linearAxis,
  logAxis,
  metrics,
  metricValue,
  modelName,
  money,
  paretoFrontier,
  provider,
  ranked,
  scoreValue,
  setupKey,
  type Snapshot,
  type State,
} from "../lib/model";
import { chart, table, tooltip } from "../lib/render";
import { strings } from "../lib/i18n";
import { validateSnapshot } from "../scripts/validate";

const results = snapshot as Snapshot;
type Configuration = Snapshot["configurations"][number];

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}

test("public snapshot contains only allowlisted aggregates", () => {
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

test("real Sol xhigh and both Astra efforts are in the first chart and table", () => {
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

test("pi DeepSeek, pi GLM and OpenCode MiMo runs start hidden", () => {
  const state = initialState(results);
  const hidden = results.configurations.filter((c) =>
    c.complete && !c.pilot &&
    ((c.agent === "pi" &&
      ["deepseek-v4.1-flash", "glm-5.3-flash"].includes(c.model)) ||
      (c.agent === "opencode" && c.model === "mimo-v2.6-pro"))
  );
  assert(hidden.length === 7);
  const rows = ranked(results, state);
  for (const c of hidden) {
    assert(!state.selected.includes(setupKey(c)));
    assert(!rows.includes(c));
    assert(!chart(results, state).includes(`data-config="${c.id}"`));
  }
  // The same models under other harnesses stay visible.
  assert(
    rows.some((c) => c.agent === "opencode" && c.model === "glm-5.3-flash"),
  );
  assert(rows.some((c) => c.agent === "pi" && c.model === "mimo-v2.6-pro"));
});

test("selection shows or hides every effort of a model+harness setup", () => {
  const state = initialState(results);
  const sol = results.configurations.filter((c) =>
    c.complete && c.model === "gpt-6.1-sol" && c.agent === "codex"
  );
  assert(sol.length > 1);
  assert(state.selected.includes("gpt-6.1-sol/codex"));
  assert(sol.every((c) => ranked(results, state).includes(c)));
  const hidden = {
    ...state,
    selected: state.selected.filter((key) => key !== "gpt-6.1-sol/codex"),
  };
  assert(!ranked(results, hidden).some((c) => sol.includes(c)));
});

test("only the newest snapshot of a model starts shown", () => {
  const base = results.configurations.find((c) =>
    c.complete && !c.pilot && c.model === "deepseek-v4.1-flash" &&
    c.agent === "opencode"
  )!;
  const data: Snapshot = {
    ...results,
    configurations: [
      ...results.configurations.filter((c) =>
        !c.model.startsWith("deepseek-v4.1-flash-")
      ),
      { ...base, id: "new/low", model: "deepseek-v4.1-flash-1017" },
      // Unfinished, so it cannot supersede 1017.
      {
        ...base,
        id: "pending/low",
        model: "deepseek-v4.1-flash-1231",
        complete: false,
      },
    ],
  };
  const state = initialState(data);
  assert(state.selected.includes("deepseek-v4.1-flash-1017/opencode"));
  assert(!state.selected.includes("deepseek-v4.1-flash/opencode"));
  assert(!state.selected.includes("deepseek-v4.1-flash/pi"));
  assert(!ranked(data, state).some((c) => c.model === "deepseek-v4.1-flash"));
  // Other models are unaffected.
  assert(state.selected.includes("glm-5.3-flash/opencode"));
  // Without a newer snapshot, the undated release stays shown.
  assert(
    initialState({ ...results, configurations: [base] }).selected.includes(
      "deepseek-v4.1-flash/opencode",
    ),
  );
});

test("latest DeepSeek efforts and only OpenCode Mistral start shown; hidden runs can be enabled", () => {
  const state = initialState(results);
  const rows = ranked(results, state);
  const deepseek = rows.filter((c) => c.model.startsWith("deepseek"));
  assert(deepseek.length === 3);
  assert(deepseek.every((c) => c.model === "deepseek-v4.1-flash-1017"));
  const mistral = results.configurations.filter((c) =>
    c.model === "mistral-large-4-0"
  );
  assert(mistral.length === 2);
  assert(rows.filter((c) => mistral.includes(c)).length === 1);
  assert(
    rows.some((c) => c.model === "mistral-large-4-0" && c.agent === "opencode"),
  );
  const pi = mistral.find((c) => c.agent === "pi")!;
  assert(!table(results, state).includes(`data-config="${pi.id}"`));
  assert(
    table(results, { ...state, selected: [...state.selected, setupKey(pi)] })
      .includes(`data-config="${pi.id}"`),
  );
  for (const c of mistral) {
    const selected = { ...state, selected: [setupKey(c)] };
    assert(table(results, selected).includes(`≥$${c.cost!.toFixed(2)}`));
    assert(tooltip(c, selected).includes(`≥$${c.cost!.toFixed(2)}`));
    assert(country(c) === "fr");
  }
});

test("model names use provider branding throughout the results UI", () => {
  for (const c of results.configurations) {
    assert(modelName(c.model) !== c.model, `Missing display name: ${c.model}`);
    assert(configName(c).startsWith(`${modelName(c.model)} (`));
  }
  assert(modelName("claude-opus-5-5") === "Claude Opus 5.5");
  assert(modelName("k3") === "Kimi K3");
  assert(modelName("claude-sonnet-5-5-low") === "Claude Sonnet 5.5");
  // Don't invent branding for a model that hasn't been verified yet.
  assert(modelName("future-model") === "future-model");
  for (const lang of ["en", "zh"] as const) {
    const state = initialState(results, lang);
    const graph = chart(results, state);
    const leaderboard = table(results, state);
    for (const c of ranked(results, state)) {
      const name = modelName(c.model);
      const value = metricValue(c, state.metric, state.category);
      if (value !== null && value > 0) assert(graph.includes(`>${name}<tspan`));
      assert(leaderboard.includes(name));
      assert(tooltip(c, state).includes(`<strong>${name}</strong>`));
    }
  }
});

test("incomplete runs and completed pilots cannot enter rankings", () => {
  const state: State = {
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

test("sorting and category views use the recorded measurements", () => {
  const state: State = { ...initialState(results), efforts: "all" };
  const scoreOrder = ranked(results, state);
  assert(
    scoreOrder.every((c: Configuration, i: number) =>
      i === 0 || c.score! <= scoreOrder[i - 1]!.score!
    ),
  );
  const costOrder = ranked(results, {
    ...state,
    sort: "cost",
    ascending: true,
  });
  assert(
    costOrder.every((c: Configuration, i: number) =>
      i === 0 || (c.cost ?? Infinity) >= (costOrder[i - 1]!.cost ?? Infinity)
    ),
  );
  for (const category of ["handwritten", "digital"] as const) {
    const rows = ranked(results, { ...state, category });
    assert(rows.length >= 2);
    for (const row of rows) {
      assert(scoreValue(row, category) === row[`${category}_score`]);
    }
  }
});

test("deselection gives an honest empty state and axes include every real point", () => {
  const state = initialState(results);
  const empty: State = {
    ...state,
    selected: [],
  };
  assert(ranked(results, empty).length === 0);
  assert(chart(results, empty).includes("No runs to plot"));
  assert(
    table(results, empty).includes("No completed runs selected"),
  );
  for (const metric of ["cost", "output_tokens", "agent_seconds"] as const) {
    const values = ranked(results, state).map((c: Configuration) => c[metric])
      .filter((v): v is number => v !== null && v > 0);
    const { unit, limit } = metrics[metric as keyof typeof metrics] as {
      unit?: number;
      limit?: number;
    };
    const axis = logAxis(values, unit, limit);
    assert(axis.min > 0 && axis.min < Math.min(...values));
    assert(axis.max > Math.max(...values));
    for (const value of values) {
      assert(axis.position(value) > 0 && axis.position(value) < 1);
    }
    // Equal multiplicative changes must occupy equal horizontal distances.
    const first = values[0]!;
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

test("linear scale starts at zero and covers every real point", () => {
  const state: State = { ...initialState(results), scale: "linear" };
  for (const metric of ["cost", "output_tokens", "agent_seconds"] as const) {
    const values = ranked(results, state).map((c: Configuration) => c[metric]!);
    const { unit, limit } = metrics[metric as keyof typeof metrics] as {
      unit?: number;
      limit?: number;
    };
    const axis = linearAxis(values, unit, limit);
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

test("Pareto frontier keeps exactly the undominated configurations", () => {
  const state = initialState(results);
  for (const category of ["overall", "handwritten", "digital"] as const) {
    for (const metric of ["cost", "output_tokens", "agent_seconds"] as const) {
      const rows = ranked(results, { ...state, category });
      const frontier = paretoFrontier(rows, metric, category);
      const dominated = (c: Configuration) =>
        rows.some((o: Configuration) =>
          o !== c &&
          metricValue(o, metric, category)! <=
            metricValue(c, metric, category)! &&
          scoreValue(o, category)! >= scoreValue(c, category)! &&
          (metricValue(o, metric, category)! <
              metricValue(c, metric, category)! ||
            scoreValue(o, category)! > scoreValue(c, category)!)
        );
      for (const c of rows) {
        assert(frontier.includes(c) === !dominated(c), `${c.id} ${metric}`);
      }
    }
  }
  assert(!chart(results, state).includes('class="pareto"'));
  const shown = chart(results, { ...state, frontier: true });
  // The frontier is drawn but not labelled: its toggle already names it.
  assert(
    shown.includes('class="pareto"') && !shown.includes("Pareto frontier"),
  );
  assert(
    shown.split('class="series-label"').length ===
      chart(results, state).split('class="series-label"').length,
  );
  // Showing the frontier marks exactly its points, so the rest can fade.
  const marked = shown.match(/class="point on-frontier"/g)?.length ?? 0;
  assert(shown.includes('class="show-frontier"'));
  const vertices = shown.match(/<polyline class="pareto" points="([^"]*)"/)![1]
    .split(" ").length;
  assert(marked === vertices, `${marked} marked, ${vertices} on the frontier`);
  assert(!chart(results, state).includes("on-frontier"));
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

test("English and Chinese dictionaries have the same keys", () => {
  const en = shape(strings.en), zh = shape(strings.zh);
  assert(
    JSON.stringify(en) === JSON.stringify(zh),
    `Keys differ: ${[
      ...en.filter((k) => !zh.includes(k)),
      ...zh.filter((k) => !en.includes(k)),
    ]}`,
  );
});

test("Chinese chart and table contain no English interface text", () => {
  const state = initialState(results, "zh");
  const html = [
    chart(results, { ...state, frontier: true }),
    chart(results, { ...state, scale: "linear", metric: "agent_seconds" }),
    chart(results, { ...state, category: "digital" }),
    table(results, state),
    table(results, { ...state, selected: [] }),
    chart(results, { ...state, selected: [] }),
  ].join("\n");
  // Model branding stays in its official form in both languages, even when
  // it contains an English provider name such as DeepSeek.
  const interfaceHtml = results.configurations.reduce(
    (markup, c) => markup.replaceAll(modelName(c.model), ""),
    html,
  );
  for (const english of leaves(strings.en)) {
    // Short words such as "Run" or "Log" are too likely to occur in data.
    if (english.length < 4 || leaves(strings.zh).includes(english)) continue;
    assert(
      !interfaceHtml.includes(english),
      `English text in Chinese page: ${english}`,
    );
  }
  assert(html.includes("（对数刻度）") && html.includes("时限"));
  assert(html.includes("分钟") && !html.includes(" min<"));
});

test("Chinese formatting uses Chinese units and effort names", () => {
  assert(duration(90, "zh") === "1.5 分钟" && duration(45, "zh") === "45 秒");
  assert(duration(90) === "1.5 min" && duration(45) === "45 s");
  assert(effortName({ model: "k3", effort: null }, "zh") === "默认");
  assert(effortName({ model: "k3", effort: "xhigh" }, "zh") === "xhigh");
  assert(strings.zh.date("2026-10-05T01:00:00Z") === "2026年10月5日");
});

test("every recorded model belongs to a known provider", () => {
  for (const c of results.configurations) {
    assert(provider(c) !== "other", `No provider for model ${c.model}`);
    assert(provider(c) in strings.en.providers);
  }
});

test("filters combine alternatives within a facet and facets together", () => {
  const state = initialState(results);
  const all = ranked(results, state);
  const by = (filters: Partial<State["filters"]>) =>
    ranked(results, {
      ...state,
      filters: { agent: [], provider: [], country: [], model: [], ...filters },
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
    openaiPi.length ===
        all.filter((c: Configuration) =>
          c.agent === "pi" && provider(c) === "openai"
        ).length &&
      openaiPi.every((c: Configuration) =>
        c.agent === "pi" && provider(c) === "openai"
      ),
  );
  assert(by({ provider: ["anthropic"], agent: ["codex"] }).length === 0);
  // The chart, table and "Best" view all show only filtered runs.
  const filters = {
    agent: [],
    provider: [],
    country: [],
    model: ["gpt-6.1-sol"],
  };
  for (const efforts of ["all", "best"] as const) {
    const view: State = { ...state, efforts, filters };
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

test("filter options come only from completed runs", () => {
  const state = initialState(results);
  const values = facetValues(results, state.cohort);
  const completed = ranked(results, {
    ...state,
    selected: results.configurations.map(setupKey),
  });
  assert(
    JSON.stringify(values.agent) ===
      JSON.stringify(
        [...new Set(completed.map((c: Configuration) => c.agent))].sort(),
      ),
  );
  assert(
    JSON.stringify(values.model) ===
      JSON.stringify(
        [...new Set(completed.map((c: Configuration) => c.model))].sort(),
      ),
  );
  assert(values.provider.every((p: string) => p in strings.zh.providers));
});

test("developer country filters compose with harness and model filters", () => {
  const state = initialState(results);
  const all = ranked(results, state);
  const china = ranked(results, {
    ...state,
    filters: { ...state.filters, country: ["cn"] },
  });
  const us = ranked(results, {
    ...state,
    filters: { ...state.filters, country: ["us"] },
  });
  assert(china.length > 0 && us.length > 0);
  assert(china.every((c: Configuration) => country(c) === "cn"));
  assert(us.every((c: Configuration) => country(c) === "us"));
  const france = ranked(results, {
    ...state,
    filters: { ...state.filters, country: ["fr"] },
  });
  assert(france.length > 0 && france.every((c) => country(c) === "fr"));
  assert(china.length + us.length + france.length === all.length);
  const piChina = ranked(results, {
    ...state,
    filters: { ...state.filters, country: ["cn"], agent: ["pi"] },
  });
  assert(
    piChina.length > 0 &&
      piChina.every((c: Configuration) =>
        country(c) === "cn" && c.agent === "pi"
      ),
  );
  assert(country({ model: "deepseek-v4.1-flash" }) === "cn");
  assert(country({ model: "unknown-model" }) === "other");
  assert(
    facetValues(results, state.cohort).country.every((c: string) =>
      c in strings.zh.countries
    ),
  );
});

test("leaderboard has decorative model and pi/OpenCode SVG marks", () => {
  const html = table(results, initialState(results));
  for (
    const brand of [
      "openai",
      "anthropic",
      "deepseek",
      "zai",
      "xiaomi",
      "pi",
      "opencode",
    ]
  ) {
    assert(html.includes(`data-brand="${brand}"`), `Missing logo: ${brand}`);
  }
  assert(html.includes('class="brand-logo harness-logo"'));
  assert(html.includes('aria-hidden="true" focusable="false"'));
  assert(!html.includes("<img"));
});

test("category metrics come from their own task records", async () => {
  const { aggregate } = await import("../scripts/refresh");
  const bundle = {
    schema_version: 1,
    benchmark: "tikz-bench",
    generated_at: "2026-10-12T00:00:00Z",
    runs: [{ id: "sample", subset_id: "sample", figure_ids: ["a", "b"] }],
    configurations: [{
      id: "sample/config",
      run_id: "sample",
      model: "gpt-test",
      resolved_model: "claude-haiku-5-5",
      agent: "codex",
      effort: null,
      label: "sample",
      complete: true,
      summary: {
        planned_tasks: 2,
        scored_tasks: 2,
        generated_tasks: 2,
        score: 1,
        cost_missing: 0,
        cost_per_task: 5,
        output_tokens_mean: 200,
        agent_seconds_mean: 60,
        seconds_mean: 30,
        compile_rate: 1,
        cost_sources: [],
      },
      score_breakdown: {
        handwritten_cleanup: {
          planned: 1,
          complete: true,
          score: 1,
          perfect: 1,
        },
        digital_exact: { planned: 1, complete: true, score: 1, perfect: 1 },
      },
    }],
    tasks: [
      {
        configuration_id: "sample/config",
        score: 1,
        reproduction_policy: "handwritten_cleanup",
        metrics: {
          cost_usd: 2,
          agent_seconds: 40,
          api_seconds: 20,
          completion_tokens: 100,
        },
      },
      {
        configuration_id: "sample/config",
        score: 1,
        reproduction_policy: "digital_exact",
        metrics: {
          cost_usd: 8,
          agent_seconds: 80,
          api_seconds: 40,
          completion_tokens: 300,
        },
      },
    ],
  };
  const data = aggregate(bundle);
  validateSnapshot(data);
  const c = data.configurations[0];
  assert(c.model === "claude-haiku-5-5");
  assert(metricValue(c, "cost") === 5);
  assert(metricValue(c, "cost", "handwritten") === 2);
  assert(metricValue(c, "cost", "digital") === 8);
  assert(metricValue(c, "agent_seconds", "handwritten") === 40);
  assert(metricValue(c, "agent_seconds", "digital") === 80);
  const state = initialState(data);
  assert(table(data, { ...state, category: "handwritten" }).includes("$2.00"));
  assert(table(data, { ...state, category: "digital" }).includes("$8.00"));
  bundle.tasks[1].metrics.cost_usd = null as unknown as number;
  assert(aggregate(bundle).configurations[0].digital_cost === null);
});

test("taste view ranks saved taste ratings and uses handwritten metrics", () => {
  const state: State = { ...initialState(results), category: "taste" };
  const rows = ranked(results, state);
  assert(rows.length > 0);
  for (const c of rows) {
    assert(scoreValue(c, "taste") === c.taste_score! / 10);
    assert(metricValue(c, "cost", "taste") === c.handwritten_cost);
    assert(
      metricValue(c, "agent_seconds", "taste") === c.handwritten_agent_seconds,
    );
  }
  assert(
    rows.every((c: Configuration, i: number) =>
      !i || Number(rows[i - 1]!.taste_score) >= Number(c.taste_score)
    ),
  );
  assert(
    table(results, state).includes(`${rows[0]!.taste_score!.toFixed(1)}/10`),
  );
  assert(chart(results, state).includes("Hand-drawn taste (out of 10)"));
  const missing = { ...rows[0]!, taste_score: null };
  assert(scoreValue(missing, "taste") === null);
});

test("each lab has one chart colour and every series a direct label", () => {
  for (const c of results.configurations) {
    assert(color(c) === `var(--lab-${provider(c)})`);
  }
  assert(color({ model: "gpt-6.1-sol" }) === color({ model: "gpt-6-astra" }));
  assert(
    color({ model: "gpt-6.1-sol" }) !== color({ model: "claude-opus-5-5" }),
  );
  const state = initialState(results);
  const html = chart(results, state);
  const series = new Set(
    ranked(results, state).filter((c) => {
      const value = metricValue(c, state.metric, state.category);
      return value !== null && value > 0;
    }).map((c: Configuration) => `${c.model}/${c.agent}`),
  );
  assert(html.split('class="series-label"').length - 1 === series.size);
});

test("chart omits effort labels but keeps them in point tooltips", () => {
  const html = chart(results, initialState(results));
  assert(!html.includes('class="effort"'));
  assert(html.includes("(xhigh)"));
  assert(html.includes('class="point"'));
});

test("hovering a point shows its values on both axes and in a card", () => {
  const state = initialState(results);
  const html = chart(results, state);
  const points = html.split('class="point').length - 1;
  assert(html.split('class="crosshair"').length - 1 === points);
  assert(!html.includes("<title>"));
  const c = ranked(results, state)[0];
  const card = tooltip(c, state);
  assert(card.includes(modelName(c.model)) && card.includes(c.agent));
  assert(card.includes(`${effortName(c)}, ${c.agent}</div>`));
  assert(card.includes(formatScore(scoreValue(c, "overall"), "overall")));
  assert(card.includes(money(metricValue(c, "cost"))));
  // The two plotted values, score and the chart's metric, are emphasized.
  assert(card.split('class="plotted"').length - 1 === 2);
  assert(!tooltip(c, { ...state, lang: "zh" }).includes("Click"));
});

test("MiMo uses the same enabled-reasoning label across harnesses", () => {
  const runs = results.configurations.filter((c) =>
    c.model === "mimo-v2.6-pro"
  );
  assert(runs.length === 2);
  for (const c of runs) {
    assert(effortName(c, "en") === "on");
    assert(effortName(c, "zh") === "on");
  }
});

test("agent time axes end at the one-hour generation limit", () => {
  const state = initialState(results);
  const values = ranked(results, state).map((c: Configuration) =>
    c.agent_seconds!
  );
  for (
    const axis of [logAxis(values, 60, 3600), linearAxis(values, 60, 3600)]
  ) {
    assert(axis.max === 3600 && axis.ticks.at(-1) === 3600);
    assert(axis.ticks.every((v: number) => v % 60 === 0 || v < 60));
  }
  // A configuration whose every task timed out sits on the limit line.
  assert(logAxis([60, 3600], 60, 3600).position(3600) === 1);
  for (const scale of ["log", "linear"] as const) {
    const svg = chart(results, { ...state, metric: "agent_seconds", scale });
    assert(svg.includes('class="limit"'));
    assert(svg.includes("60 min limit: unfinished tasks score 0"));
  }
  assert(!chart(results, state).includes('class="limit"'));
});

test("Argon reasoning levels share one model series", () => {
  const rows = results.configurations.filter((c) =>
    c.run === "agy-gemini4-argon-high-20261014" ||
    c.run === "agy-gemini4-argon-medium-20261015"
  );
  assert(rows.length === 2);
  assert(rows.every((c) => c.model === "gemini-4-argon"));
  assert(new Set(rows.map((c) => c.effort)).size === 2);
  const html = chart(
    { ...results, configurations: rows },
    initialState(results),
  );
  assert(html.split('class="series-label"').length - 1 === 1);
});

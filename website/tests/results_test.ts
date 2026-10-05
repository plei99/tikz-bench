import results from "../src/data/results.json" with { type: "json" };
import {
  initialState,
  linearAxis,
  logAxis,
  metrics,
  metricValue,
  paretoFrontier,
  ranked,
  scoreValue,
} from "../src/lib/model.js";
import { chart, table } from "../src/lib/render.js";
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

import { expect, test } from "bun:test";
import snapshot from "../data/results.json";
import {
  formatMetric,
  initialState,
  metricValue,
  type Snapshot,
} from "../lib/model";
import { chart, table, tooltip } from "../lib/render";

const data = snapshot as Snapshot;
const configuration = (model: string, effort: string, agent: string) =>
  data.configurations.find((c) =>
    c.complete && c.model === model && c.effort === effort && c.agent === agent
  )!;

test("subscription dollars allocate the actual monthly fee to each task", () => {
  expect(
    metricValue(
      configuration("gpt-6.1-sol", "xhigh", "codex"),
      "subscription_cost",
    ),
  ).toBeCloseTo(0.00853587255, 10);
  expect(
    metricValue(configuration("k3.1-pro", "max", "kimi"), "subscription_cost"),
  ).toBeCloseTo(0.16161249097, 10);
  // Flash high's measured tokens cost 0.0472635% of the $80 plan, not $100.
  expect(
    metricValue(
      configuration("glm-5.3-flash", "high", "opencode"),
      "subscription_cost",
    ),
  ).toBeCloseTo(0.03781079994, 10);
  expect(
    metricValue(
      configuration("mimo-v2.6-pro", "high", "pi"),
      "subscription_cost",
    ),
  ).toBeCloseTo(0.43044335439, 10);
});

test("category estimates price the selected tasks, and taste uses hand-drawn tasks", () => {
  for (
    const c of data.configurations.filter((c) =>
      c.complete && ["glm-5.3-flash", "mimo-v2.6-pro"].includes(c.model)
    )
  ) {
    const hand = metricValue(c, "subscription_cost", "handwritten")!;
    const digital = metricValue(c, "subscription_cost", "digital")!;
    expect(hand).toBeGreaterThan(0);
    expect(digital).toBeGreaterThan(0);
    expect(hand).not.toBe(digital);
    expect(metricValue(c, "subscription_cost")).toBeCloseTo(
      0.8 * hand + 0.2 * digital,
      10,
    );
    expect(metricValue(c, "subscription_cost", "taste")).toBe(hand);
  }
});

test("new or changed credit-based generations require matching token evidence", () => {
  const c = configuration("glm-5.3-flash", "high", "opencode");
  for (
    const changed of [{ ...c, id: "new/run" }, { ...c, cost: c.cost! + 1 }, {
      ...c,
      output_tokens: c.output_tokens! + 1,
    }]
  ) {
    expect(metricValue(changed, "subscription_cost")).toBeNull();
  }
  expect(metricValue({ ...c, score: 0.9 }, "subscription_cost")).toBe(
    metricValue(c, "subscription_cost"),
  );
});

test("subscription charts show dollars and explain missing estimates in both languages", () => {
  const c = configuration("gpt-6.1-sol", "xhigh", "codex");
  for (const lang of ["en", "zh"] as const) {
    const state = {
      ...initialState(data, lang),
      metric: "subscription_cost" as const,
    };
    const html = chart(data, state);
    expect(html).toContain(`data-config="${c.id}"`);
    const missing = data.configurations.find((c) =>
      c.complete && c.model === "mistral-large-4-0"
    )!;
    expect(html).not.toContain(`data-config="${missing.id}"`);
    expect(html).not.toContain("NaN");
    expect(html).toContain(
      lang === "en" ? "assuming full allowance use" : "假设充分使用额度",
    );
    expect(html).toContain(
      lang === "en" ? "have no subscription estimate" : "没有订阅估算",
    );
    expect(tooltip(c, state)).toContain("$0.00854");
    expect(table(data, state)).toContain("$0.00854");
  }
});

test("small subscription prices retain meaningful digits", () => {
  expect(formatMetric(0.00011576936, "subscription_cost")).toBe("$0.000116");
  expect(formatMetric(null, "subscription_cost")).toBe("—");
  expect(formatMetric(0, "subscription_cost")).toBe("$0");
});

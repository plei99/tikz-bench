import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import snapshot from "../data/results.json";
import { inlineScript } from "../lib/inline";
import { chart, table, tooltip } from "../lib/render";
import { initialState, type Snapshot } from "../lib/model";
import { validateSnapshot } from "../scripts/validate";

test("malformed browser data is rejected before it can be rendered as HTML", () => {
  for (
    const field of ["handwritten_perfect", "digital_perfect", "score", "cost"]
  ) {
    const data = structuredClone(snapshot);
    Object.assign(data.configurations[0]!, {
      [field]: '<img src=x onerror="alert(1)">',
    });
    expect(() => validateSnapshot(data)).toThrow();
  }
});

test("result labels stay text in chart, table and tooltip HTML", () => {
  const data = structuredClone(snapshot) as Snapshot;
  for (const c of data.configurations) {
    c.model = '<img src=x onerror="alert(1)">';
    c.agent = "<script>alert(1)</script>";
  }
  const state = initialState(data);
  for (
    const markup of [
      chart(data, state),
      table(data, state),
      tooltip(data.configurations[0]!, state),
    ]
  ) {
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("<script");
    expect(markup).toContain("&lt;");
  }
});

test("inline language constants cannot close their HTML script element", async () => {
  const destination = "</script><script>alert(1)</script>";
  const code = await inlineScript("detect-language", {
    SITE_ROOT: "https://example.test/tikz-bench/",
    ZH_PAGE: destination,
  });
  expect(code.toLowerCase()).not.toContain("</script");
  let replaced = "";
  runInNewContext(code, {
    localStorage: { getItem: () => null },
    navigator: { language: "zh" },
    document: { referrer: "" },
    location: {
      hash: "",
      replace(value: string) {
        replaced = value;
      },
    },
  });
  expect(replaced).toBe(destination);
});

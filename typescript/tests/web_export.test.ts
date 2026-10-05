import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "../src/cli.ts";
import { scoreBreakdown } from "../src/web_export.ts";
import { readJSON, writeJSON } from "../src/support.ts";
import { harness, reply, ALL_PASS } from "./harness.ts";
import { SLOW } from "./helpers.ts";

test("website export CLI selects all runs by default or one named run", () => {
  assert.equal(parseArgs(["export"])!.run, undefined);
  assert.equal(parseArgs(["export", "--run", "test"])!.run, "test");
  assert.throws(() => parseArgs(["export", "--force"]));
});

test("partial and mixed grader scores cannot become category leaderboard scores", () => {
  const task = { reproduction_policy: "handwritten_cleanup", score: 1 };
  const partial = scoreBreakdown([
    task,
    { ...task, score: null },
  ]).handwritten_cleanup;
  assert.equal(partial.score, null);
  assert.equal(partial.observed_score, 1);
  assert.equal(partial.complete, false);
  const mixed = scoreBreakdown(
    ["high", "medium"].map((effort) => ({
      ...task,
      grade: { valid: true, params: { reasoning_effort: effort } },
    })),
  ).handwritten_cleanup;
  assert.equal(mixed.score, null);
  assert.equal(mixed.mixed_judges, true);
});

test(
  "website bundle preserves scores, panel votes and portable images without logs",
  SLOW,
  () =>
    harness(async (h) => {
      h.args.figures = ["figure_a", "figure_b"];
      h.jargs.reasoning_effort = "high";
      await h.digitalFigure("match");
      await h.submitAnswers();
      assert.equal((await h.judge(reply(ALL_PASS))).code, 0);
      const judgeFile = path.join(h.modelDir, "figure_b.judge.json"),
        j = readJSON(judgeFile);
      j.panel_reviews.codex.text = "private raw CLI reply";
      j.panel_reviews.codex.auth_source = "/private/credential/location";
      writeJSON(judgeFile, j);
      const out = path.join(h.root, "runs/web-results"),
        bundle = h.m.web.exportWebsite(out, "test");
      assert.equal(bundle.schema_version, 1);
      assert.equal(bundle.configurations.length, 1);
      assert.equal(bundle.configurations[0].summary.score, 1);
      assert.equal(bundle.configurations[0].summary.generated_tasks, 2);
      assert.equal(
        bundle.configurations[0].score_breakdown.digital_exact.perfect,
        1,
      );
      assert.equal(bundle.tasks.length, 2);
      const panel = bundle.tasks.find((t) => t.figure_id === "figure_b")!;
      assert.equal(panel.grade.valid, true);
      assert.equal(panel.grade.params.reasoning_effort, "high");
      assert.equal(panel.grade.claims.length, 2);
      assert.deepEqual(panel.grade.claims[0].judges, {
        codex: true,
        claude: true,
      });
      const digital = bundle.tasks.find((t) => t.figure_id === "figure_a")!;
      assert.equal(digital.grade.comparison.exact_match, true);
      assert.ok(digital.grade.comparison.images.difference);
      const text = fs.readFileSync(path.join(out, "results.json"), "utf8");
      for (const secret of [
        h.root,
        "private raw CLI reply",
        "/private/credential/location",
        "auth_source",
      ])
        assert.ok(!text.includes(secret), secret);
      for (const url of [
        ...bundle.figures.map((f) => f.reference_image),
        ...bundle.tasks.map((t) => t.rendering),
        ...Object.values(digital.grade.comparison.images),
      ]) {
        assert.match(url as string, /^assets\/[a-f0-9]{64}\.png$/);
        assert.ok(fs.existsSync(path.join(out, url as string)));
      }
      const again = h.m.web.exportWebsite(out, "test");
      assert.deepEqual(
        again.tasks.map((t) => t.id),
        bundle.tasks.map((t) => t.id),
      );
      assert.deepEqual(again.figures, bundle.figures);
      assert.throws(
        () => h.m.web.exportWebsite(h.runDir, "test"),
        /source or run directory/,
      );
    }),
);

test(
  "website export flags stale grades and retains unstarted tasks without scores",
  SLOW,
  () =>
    harness(async (h) => {
      h.args.figures = ["figure_a", "figure_b"];
      h.m.plan.plan(h.args, { isolation: "external_unverified" });
      h.args.figures = ["figure_a"];
      await h.submitAnswers();
      assert.equal((await h.judge(reply(ALL_PASS))).code, 0);
      const file = h.stem + ".judge.json",
        j = readJSON(file);
      j.score = 0; // Stored score contradicts the unanimous verdicts.
      writeJSON(file, j);
      const legacy = path.join(h.root, "runs/legacy");
      fs.mkdirSync(legacy);
      writeJSON(path.join(legacy, "run.json"), { track: "api" });
      const bundle = h.m.web.exportWebsite(
        path.join(h.root, "runs/web-results"),
      );
      assert.equal(bundle.configurations[0].complete, false);
      assert.equal(bundle.configurations[0].summary.score, null);
      const stale = bundle.tasks.find((t) => t.figure_id === "figure_a")!;
      assert.equal(stale.grading_status, "stale");
      assert.equal(stale.score, null);
      assert.equal(stale.grade.stored_score, 0);
      assert.equal(stale.grade.valid, false);
      assert.deepEqual(stale.grade.claims, []);
      const pending = bundle.tasks.find((t) => t.figure_id === "figure_b")!;
      assert.equal(pending.grading_status, "ungraded");
      assert.equal(pending.score, null);
      assert.equal(pending.rendering, null);
      assert.equal(bundle.configurations[0].summary.generated_tasks, 1);
      assert.deepEqual(bundle.skipped_runs, [
        { run_id: "legacy", reason: "retired_protocol" },
      ]);
    }),
);

// Ported from the retired Python tests/test_visual_compare.py. Pass/fail
// verdicts on every synthetic case and on the recovered originals are the
// frozen differential fixtures in runtime.test.ts; these cover the rest.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { temporary } from "../src/process.ts";
import { compare, gateScores, partialScore } from "../src/visual_compare.ts";
import { fixture } from "./helpers.ts";

test("matching renderings save reference, candidate and difference artifacts", () =>
  temporary("tikz-visual-artifacts-", async (dir) => {
    for (const name of ["identity", "padding", "alpha", "scale"]) {
      const r = await compare(
        fixture("reference.png"),
        fixture(name + ".png"),
        path.join(dir, name),
      );
      assert.equal(r.exact_match, true, name);
      assert.equal(r.score, 1, name);
      assert.deepEqual(Object.keys(r.artifacts).sort(), [
        "candidate",
        "difference",
        "reference",
      ]);
    }
  }));

test("output is repeatable and an empty reference is a data error", () =>
  temporary("tikz-visual-repeat-", async (dir) => {
    const grade = path.join(dir, "grade"),
      first = await compare(
        fixture("reference.png"),
        fixture("label.png"),
        grade,
      );
    assert.deepEqual(
      await compare(fixture("reference.png"), fixture("label.png"), grade),
      first,
    );
    const blank = path.join(dir, "blank-reference.png");
    fs.copyFileSync(fixture("blank.png"), blank);
    await assert.rejects(
      compare(blank, fixture("reference.png"), grade),
      /reference image/,
    );
  }));

test("each gate earns tiered credit by its multiple of the limit", () => {
  const m = {
    bad_fraction: 0.001, // at the limit: 0.2
    largest_bad_component: 12, // 2x: 0.15
    worst_patch_mass_error: 0.7, // 2.8x: 0.1
    worst_patch_color_error: 0.88, // 4x: 0.05
    blurred_error: 0.81, // over 4x: 0
  };
  assert.deepEqual(gateScores(m), {
    bad_fraction: 0.2,
    largest_bad_component: 0.15,
    worst_patch_mass_error: 0.1,
    worst_patch_color_error: 0.05,
    blurred_error: 0,
  });
  assert.equal(partialScore(m), 0.5);
  assert.equal(partialScore({}), 0);
});

test("a blank candidate scores 0 and a failed comparison scores below 1", () =>
  temporary("tikz-visual-score-", async (dir) => {
    const blank = await compare(fixture("reference.png"), fixture("blank.png"));
    assert.equal(blank.score, 0);
    const label = await compare(
      fixture("reference.png"),
      fixture("label.png"),
      path.join(dir, "label"),
    );
    assert.equal(label.exact_match, false);
    assert.ok(label.score < 1 && label.score > 0, String(label.score));
  }));

// Ported from the retired Python tests/test_visual_compare.py. Pass/fail
// verdicts on every synthetic case and on the recovered originals are the
// frozen differential fixtures in runtime.test.ts; these cover the rest.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { temporary } from "../src/process.ts";
import { compare } from "../src/visual_compare.ts";
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

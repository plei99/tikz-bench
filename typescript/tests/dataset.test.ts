import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentRunMetadata, taskRecords } from "../src/dataset.ts";

test("request audit sidecars do not make an agent run appear mixed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tikz-record-scan-"));
  try {
    fs.writeFileSync(path.join(dir, "run.json"), '{"track":"agent"}');
    const config = path.join(dir, "model@agent-opencode-v2-high");
    fs.mkdirSync(config);
    const figure = "1809.03959_p007_0";
    const task = path.join(config, figure + ".json");
    fs.writeFileSync(task, '{"track":"agent"}');
    for (const suffix of ["judge", "model-catalog", "request-settings", "provider-error"]) {
      fs.writeFileSync(path.join(config, `${figure}.${suffix}.json`), "{}");
    }
    assert.deepEqual(taskRecords(dir), [task]);
    assert.equal(agentRunMetadata(dir).track, "agent");
    fs.writeFileSync(task, '{"track":"api"}');
    assert.throws(() => agentRunMetadata(dir), /mixed runs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

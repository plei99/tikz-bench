// Tasks one at a time: session logs collected from the worker and priced,
// run --grade, judge --figures, submit --agent-log and the usage command.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readJSON } from "../src/support.ts";
import { temporary } from "../src/process.ts";
import { Database } from "bun:sqlite";
import { collectLogsScript, opencodeUsageScript } from "../src/runner.ts";
import { priceUsage, sessionUsage } from "../src/usage.ts";
import { main } from "../src/cli.ts";
import type { CliArgs } from "../src/cli.ts";
import { quiet, withEnv, withFakeDocker, SLOW } from "./helpers.ts";
import { harness, EDITED, PARTIAL, reply } from "./harness.ts";
import type { Harness } from "./harness.ts";

const lines = (rows: unknown[]) =>
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const kimiUsage = (other: number, read: number, output: number) => ({
  type: "usage.record",
  model: "kimi-code/k3",
  usage: {
    inputOther: other,
    inputCacheRead: read,
    inputCacheCreation: 0,
    output,
  },
});
/** Kimi K3 list prices: $3 input, $0.30 cached input, $15 output. */
const kimiCost = (other: number, read: number, output: number) =>
  (other * 3 + read * 0.3 + output * 15) / 1e6;

test("session logs are read from the worker without following links", () =>
  temporary("tikz-collect-", async (dir) => {
    const root = path.join(dir, "home/.kimi-code/sessions");
    fs.mkdirSync(path.join(root, "s/agents/main"), { recursive: true });
    fs.writeFileSync(path.join(root, "s/agents/main/wire.jsonl"), "usage\n");
    fs.writeFileSync(path.join(dir, "secret"), "private");
    fs.symlinkSync(path.join(dir, "secret"), path.join(root, "link.jsonl"));
    fs.symlinkSync(dir, path.join(root, "outside"));
    const run = (max?: number) =>
      JSON.parse(
        spawnSync(
          "node",
          ["-e", collectLogsScript(max), JSON.stringify([root])],
          {
            encoding: "utf8",
          },
        ).stdout,
      );
    const all = run();
    assert.deepEqual(Object.keys(all.files), [
      path.join(root, "s/agents/main/wire.jsonl"),
    ]);
    assert.equal(
      Buffer.from(Object.values<string>(all.files)[0]!, "base64").toString(),
      "usage\n",
    );
    assert.equal(all.truncated, false);
    assert.deepEqual(run(3), { files: {}, truncated: true });
  }));

test("OpenCode usage includes subagents and leaves its credentials behind", () =>
  temporary("tikz-opencode-usage-", async (dir) => {
    const file = path.join(dir, "opencode.db"),
      out = path.join(dir, "home/.local/share/opencode/usage.json"),
      run = () =>
        JSON.parse(
          spawnSync("node", ["-e", opencodeUsageScript(file, out), "[]"], {
            encoding: "utf8",
          }).stdout,
        );
    assert.deepEqual(run(), { files: {}, truncated: false });
    const db = new Database(file);
    db.run("create table session (id text primary key, parent_id text)");
    db.run(
      "create table message (id text primary key, session_id text, time_created integer, data text)",
    );
    db.run("create table credential (value text)");
    db.run("insert into credential values ('sk-secret')");
    db.run("insert into session values ('root', null), ('child', 'root')");
    const assistant = (cost: number) =>
      JSON.stringify({
        role: "assistant",
        modelID: "glm-5.2",
        cost,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0 } },
        path: { cwd: "/workspace" },
      });
    db.run(
      "insert into message values ('1', 'root', 1, ?), ('2', 'child', 2, ?), ('3', 'root', 3, ?)",
      [assistant(0.1), assistant(0.2), JSON.stringify({ role: "user" })],
    );
    db.close();
    const saved = run(),
      text = Buffer.from(saved.files[out], "base64").toString();
    assert.deepEqual(Object.keys(saved.files), [out]);
    assert.ok(!text.includes("sk-secret") && !text.includes("/workspace"));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text);
    const usage = priceUsage(sessionUsage("opencode", [out], "root"), null);
    assert.equal(usage.models["glm-5.2"]!.requests, 2);
    assert.ok(Math.abs(usage.cost_usd! - 0.3) < 1e-9);
  }));

const automatic = (h: Harness, extra: Partial<CliArgs> = {}): CliArgs => ({
  ...h.args,
  cmd: "run",
  auth: "api",
  image: "tikz-bench-agents:test",
  network: "bridge",
  workers: 1,
  max_cost: 10,
  ...extra,
});

test(
  "a Kimi run is priced from the wire logs collected from its worker",
  SLOW,
  () =>
    harness(
      async (h) => {
        const wire = "/agent-home/.kimi-code/sessions/wd/session_1/agents";
        await withEnv({ KIMI_API_KEY: "synthetic-test-key" }, () =>
          withFakeDocker(
            {
              version: "kimi 2.0.2",
              agent: {
                stdout: lines([{ role: "assistant", content: "Done." }]),
              },
              snapshot: {
                stdout: JSON.stringify({ submission: EDITED, credentials: {} }),
              },
              logs: {
                [wire + "/main/wire.jsonl"]: lines([
                  { type: "metadata" },
                  kimiUsage(2000, 8000, 500),
                ]),
                [wire + "/agent-1/wire.jsonl"]: lines([
                  kimiUsage(1000, 0, 100),
                ]),
              },
            },
            async () => {
              const { value, lines: out } = await quiet(() =>
                h.m.commands.cmdRun(
                  automatic(h, { agent: "kimi", model: "kimi-code/k3" }),
                ),
              );
              assert.equal(value, 0, out.join("\n"));
              const [t] = h.m.task.listTasks("test");
              const rec = readJSON(t!.stem + ".json");
              assert.equal(rec.status, "ok");
              assert.equal(rec.api.usage_source, "session_logs");
              assert.equal(rec.api.cost_source, "price_table");
              assert.ok(
                Math.abs(rec.api.cost_usd - kimiCost(3000, 8000, 600)) < 1e-12,
              );
              assert.equal(rec.api.usage.prompt_tokens, 11000);
              assert.equal(rec.api.models["kimi-code/k3"].requests, 2);
              assert.deepEqual(rec.agent.session_logs, {
                files: 2,
                truncated: false,
              });
              assert.ok(
                fs.existsSync(
                  path.join(
                    t!.stem + ".agent-logs",
                    ".kimi-code/sessions/wd/session_1/agents/agent-1/wire.jsonl",
                  ),
                ),
              );
              const row = (await h.taskResults())[0];
              assert.ok(
                Math.abs(row.cost_usd - kimiCost(3000, 8000, 600)) < 1e-12,
              );
            },
          ),
        );
      },
      ["figure_a"],
    ),
);

test("run --grade grades each task as soon as it compiles", SLOW, () =>
  harness(
    async (h) => {
      await h.digitalFigure("match");
      const result = {
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.05,
        result: "done",
      };
      await withEnv({ ANTHROPIC_API_KEY: "synthetic-test-key" }, () =>
        withFakeDocker(
          {
            version: "2.1.287 (Claude Code)",
            agent: { stdout: JSON.stringify(result) },
            snapshot: {
              stdout: JSON.stringify({ submission: EDITED, credentials: {} }),
            },
          },
          async () => {
            const { value, lines: out } = await quiet(() =>
              h.m.commands.cmdRun(
                automatic(h, {
                  grade: true,
                  prompt: "judge_v1",
                  rpm: 60000,
                  judge_timeout: 1,
                  reasoning_effort: "medium",
                }),
              ),
            );
            assert.equal(value, 0, out.join("\n"));
            assert.ok(
              out.some((l) => /^ok: figure_a;.*; score 1 \(ok\)$/.test(l)),
              out.join("\n"),
            );
            assert.equal(readJSON(h.stem + ".judge.json").score, 1);
            assert.equal(h.panelsCreated, 0); // digital: no model judge
          },
        ),
      );
    },
    ["figure_a"],
  ),
);

test("judge --figures grades only the selected task", SLOW, () =>
  harness(async (h) => {
    h.setChecklist("figure_a");
    h.setChecklist("figure_b");
    h.args.figures = ["figure_a", "figure_b"];
    await h.submitAnswers();
    h.jargs.figures = ["figure_b"];
    const r = await h.judge(reply(PARTIAL));
    assert.equal(r.code, 0, r.lines.join("\n"));
    assert.ok(r.lines.includes("Checking compilation of 1 generated answers"));
    assert.equal(r.calls.length, 2); // both panel members, one task
    const stemB = path.join(h.modelDir, "figure_b");
    assert.equal(readJSON(stemB + ".judge.json").status, "ok");
    assert.ok(!fs.existsSync(h.stem + ".judge.json"));
  }),
);

test("submit takes usage and cost from the agent's session logs", SLOW, () =>
  harness(
    async (h) => {
      const out = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "tikz-out-")),
      );
      try {
        h.args = { ...h.args, agent: "kimi", model: "kimi-code/k3" };
        await quiet(() =>
          h.m.commands.cmdPrepare({
            ...h.args,
            cmd: "prepare",
            out: path.join(out, "tasks"),
          }),
        );
        const [t] = h.m.task.listTasks("test"),
          workspace = readJSON(t!.stem + ".json").agent.workspace;
        fs.writeFileSync(path.join(workspace, "notes.tex"), EDITED);
        const logs = path.join(out, "kimi-sessions");
        fs.mkdirSync(path.join(logs, "s/agents/main"), { recursive: true });
        fs.writeFileSync(
          path.join(logs, "s/agents/main/wire.jsonl"),
          lines([kimiUsage(1000, 0, 200)]),
        );
        const submit = (extra: Partial<CliArgs> = {}) =>
          quiet(() =>
            h.m.commands.cmdSubmit({
              cmd: "submit",
              run: "test",
              workspace,
              agent_log: [logs],
              force: true,
              retry_errors: false,
              ...extra,
            }),
          );
        let { value, lines: printed } = await submit();
        assert.equal(value, 0, printed.join("\n"));
        let rec = readJSON(t!.stem + ".json");
        assert.equal(rec.status, "ok");
        assert.equal(rec.api.cost_source, "price_table");
        assert.ok(Math.abs(rec.api.cost_usd - kimiCost(1000, 0, 200)) < 1e-12);
        assert.equal(rec.agent.session_logs.files.length, 1);
        assert.match(rec.agent.session_logs.files[0].sha256, /^[0-9a-f]{64}$/);
        // An operator-supplied cost still takes precedence.
        ({ value } = await submit({ cost_usd: 0.5 }));
        rec = readJSON(t!.stem + ".json");
        assert.deepEqual(
          [rec.api.cost_usd, rec.api.cost_source],
          [0.5, "operator_supplied"],
        );
        assert.equal(rec.api.usage.prompt_tokens, 1000);
        // Logs without usage are rejected rather than recorded as free.
        fs.writeFileSync(
          path.join(logs, "s/agents/main/wire.jsonl"),
          lines([{ type: "metadata" }]),
        );
        await assert.rejects(submit(), /record no usage/);
      } finally {
        fs.rmSync(out, { recursive: true, force: true });
      }
    },
    ["figure_a"],
  ),
);

test("usage prints the cost recorded in a CLI's session logs", () =>
  temporary("tikz-usage-cli-", async (dir) => {
    fs.mkdirSync(path.join(dir, "agents/main"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "agents/main/wire.jsonl"),
      lines([kimiUsage(0, 1_000_000, 0)]),
    );
    const { value, lines: out } = await quiet(() =>
      main(["usage", "--agent", "kimi", "--agent-log", dir]),
    );
    assert.equal(value, 0);
    const summary = JSON.parse(out.join("\n"));
    assert.equal(summary.cost_usd, 0.3);
    assert.equal(summary.cost_source, "price_table");
    assert.deepEqual(summary.unpriced_models, []);
    await assert.rejects(main(["usage", "--agent", "kimi"]), /--agent-log/);
  }));

/** Run a listing command in the harness and parse its --json output. */
async function listing(h: Harness, args: Partial<CliArgs>) {
  const { value, lines: out } = await quiet(() => {
    const a = {
      force: false,
      retry_errors: false,
      json: true,
      ...args,
    } as CliArgs;
    return a.cmd === "figures"
      ? h.m.commands.cmdFigures(a)
      : a.cmd === "runs"
        ? h.m.commands.cmdRuns(a)
        : h.m.commands.cmdTasks(a);
  });
  assert.equal(value, 0);
  return JSON.parse(out.join("\n"));
}

test("figures, runs and tasks list what exists, with filters", SLOW, () =>
  harness(async (h) => {
    await h.digitalFigure("match");
    h.setChecklist("figure_b");
    h.args.figures = ["figure_a", "figure_b"];
    await h.submitAnswers();
    await h.judge(reply(PARTIAL));

    const figures = await listing(h, { cmd: "figures", all: true });
    assert.deepEqual(
      figures.map((f: any) => [f.id, f.category]),
      [
        ["figure_a", "digital"],
        ["figure_b", "hand_drawn"],
      ],
    );
    assert.deepEqual(
      (await listing(h, { cmd: "figures", category: "digital" })).map(
        (f: any) => f.id,
      ),
      ["figure_a"],
    );

    const [run] = await listing(h, { cmd: "runs" });
    assert.equal(run.run, "test");
    assert.equal(run.agent, "claude");
    assert.equal(run.config, "test__model@agent-claude-default");
    assert.deepEqual(
      [run.planned, run.generated, run.scored, run.complete],
      [2, 2, 2, true],
    );
    assert.ok(Math.abs(run.cost_usd - 0.2) < 1e-9);
    assert.deepEqual(await listing(h, { cmd: "runs", agent: "codex" }), []);
    assert.equal((await listing(h, { cmd: "runs", complete: true })).length, 1);

    const tasks = await listing(h, { cmd: "tasks", run: "test" });
    assert.deepEqual(
      tasks.map((t: any) => [t.figure, t.status]),
      [
        ["figure_a", "ok"],
        ["figure_b", "ok"],
      ],
    );
    assert.equal(tasks[0].score, 1); // digital match
    assert.equal(
      tasks[1].score,
      readJSON(path.join(h.modelDir, "figure_b.judge.json")).score,
    );
    assert.deepEqual(
      (
        await listing(h, { cmd: "tasks", run: "test", figures: ["figure_b"] })
      ).map((t: any) => t.figure),
      ["figure_b"],
    );
    assert.deepEqual(
      await listing(h, { cmd: "tasks", run: "test", status: ["agent_error"] }),
      [],
    );

    // --ids prints one ID per line for use with --figures.
    const { lines: ids } = await quiet(() =>
      h.m.commands.cmdTasks({
        cmd: "tasks",
        run: "test",
        ids: true,
        force: false,
        retry_errors: false,
      }),
    );
    assert.deepEqual(ids, ["figure_a", "figure_b"]);
    assert.throws(
      () =>
        h.m.commands.cmdTasks({
          cmd: "tasks",
          run: "missing",
          force: false,
          retry_errors: false,
        }),
      /no run named missing/,
    );
  }),
);

test("listing options are validated by the CLI", async () => {
  await assert.rejects(main(["tasks"]), /--run is required/);
  await assert.rejects(
    main(["figures", "--json", "--ids"]),
    /mutually exclusive/,
  );
  await assert.rejects(main(["figures", "--run", "x"]), /unknown option/);
});

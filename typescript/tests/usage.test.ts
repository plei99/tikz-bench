// Usage and cost from CLI session logs (usage.ts). Each log format is built
// from the structure of real Codex, Claude Code, pi, OpenCode and Kimi Code
// logs; the price table is checked against costs Claude Code reported.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { temporary } from "../src/process.ts";
import {
  loadPrices,
  measure,
  priceOf,
  priceUsage,
  requestCost,
  sessionUsage,
} from "../src/usage.ts";
import type { Request } from "../src/usage.ts";
import { loadPricing } from "../src/task.ts";

const table = loadPrices();
const lines = (rows: unknown[]) =>
  rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const near = (a: number | null, b: number) =>
  assert.ok(a !== null && Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const req = (r: Partial<Request>): Request => ({
  model: "m",
  input: 0,
  cached_input: 0,
  cache_write: 0,
  cache_write_1h: 0,
  output: 0,
  reasoning: null,
  ...r,
});

test("price table: aliases, provider prefixes and [1m] variants resolve", () => {
  assert.equal(priceOf(table, "kimi-code/k3"), table.models["kimi-k3"]);
  assert.equal(
    priceOf(table, "claude-opus-5-5[1m]"),
    table.models["claude-opus-5-5"],
  );
  assert.equal(
    priceOf(table, "openai/gpt-6.1-sol"),
    table.models["gpt-6.1-sol"],
  );
  assert.equal(
    priceOf(table, "claude-haiku-4-5-20251001"),
    table.models["claude-haiku-4-5"],
  );
  assert.equal(priceOf(table, "unlisted-model"), null);
  for (const [model, p] of Object.entries(table.models))
    assert.match(
      String(p.source),
      /^https:\/\//,
      model + " needs an official source",
    );
});

test("price table reproduces costs Claude Code reported for whole sessions", () => {
  // Token totals and costUSD from a real cost-state: the Opus main session
  // writes the one-hour cache, its Sonnet subagents the five-minute cache.
  const opus = table.models["claude-opus-5-5"]!,
    sonnet = table.models["claude-sonnet-5-5"]!;
  const prompt = (input: number, read: number, write: number) =>
    input + read + write;
  near(
    requestCost(
      opus,
      req({
        input: prompt(896, 123136622, 4991118),
        cached_input: 123136622,
        cache_write: 4991118,
        cache_write_1h: 4991118,
        output: 251939,
      }),
    ),
    69.5986324,
  );
  near(
    requestCost(
      sonnet,
      req({
        input: prompt(1864, 37489667, 5602025),
        cached_input: 37489667,
        cache_write: 5602025,
        output: 1104108,
      }),
    ),
    32.5478039,
  );
});

test("long-context prices apply per request, not to session totals", () => {
  const p = table.models["gpt-6.1-sol"]!,
    short = req({ input: 200_000, cached_input: 100_000, output: 1000 }),
    long = req({ input: 300_000, cached_input: 100_000, output: 1000 });
  near(requestCost(p, short), (100_000 * 2 + 100_000 * 0.1 + 1000 * 10) / 1e6);
  near(requestCost(p, long), (200_000 * 4 + 100_000 * 0.2 + 1000 * 15) / 1e6);
  assert.throws(() => requestCost(p, req({ input: 1, cached_input: 2 })));
});

test("codex rollouts: per-response records, resumed copies counted once, totals as fallback", () =>
  temporary("tikz-codex-logs-", async (dir) => {
    const record = (
      id: string,
      input: number,
      cached: number,
      output: number,
    ) => ({
      type: "token_usage_record",
      payload: {
        response_id: id,
        usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          cache_write_input_tokens: 0,
          output_tokens: output,
          reasoning_output_tokens: 7,
        },
      },
    });
    const ctx = (model: string) => ({
      type: "turn_context",
      payload: { model },
    });
    write(
      path.join(dir, "2026/10/03/rollout-a.jsonl"),
      lines([
        ctx("gpt-6.1-sol"),
        record("r1", 1000, 800, 50),
        ctx("gpt-6-luna"),
        record("r2", 300_000, 0, 10),
      ]),
    );
    // A resumed session repeats r1.
    write(
      path.join(dir, "2026/10/03/rollout-b.jsonl"),
      lines([ctx("gpt-6.1-sol"), record("r1", 1000, 800, 50)]),
    );
    // An older CLI version: running totals only.
    write(
      path.join(dir, "2026/10/02/rollout-c.jsonl"),
      lines([
        ctx("gpt-6.1-sol"),
        {
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 10,
                cached_input_tokens: 0,
                output_tokens: 1,
              },
            },
          },
        },
        {
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 20,
                cached_input_tokens: 5,
                output_tokens: 2,
              },
            },
          },
        },
      ]),
    );
    const u = sessionUsage("codex", [dir]);
    assert.equal(u.files.length, 3);
    assert.equal(u.requests.length, 3);
    const p = priceUsage(u, table);
    assert.equal(p.models["gpt-6.1-sol"]!.requests, 1); // the aggregate is not a request
    assert.equal(p.models["gpt-6.1-sol"]!.input_tokens, 1020);
    // Running totals cannot be split into requests: base-tier prices.
    assert.equal(p.models["gpt-6-luna"]!.cost_source, "price_table");
    assert.equal(p.models["gpt-6.1-sol"]!.cost_source, "mixed");
    assert.equal(p.cost_source, "mixed");
    near(
      p.cost_usd,
      (200 * 2 + 800 * 0.1 + 50 * 10) / 1e6 +
        (15 * 2 + 5 * 0.1 + 2 * 10) / 1e6 +
        (300_000 * 0.2 + 10 * 0.75) / 1e6,
    );
  }));

test("claude transcripts: messages counted once; current cost-state is authoritative", () =>
  temporary("tikz-claude-logs-", async (dir) => {
    const message = (
      id: string,
      model: string,
      output: number,
      oneHour: boolean,
    ) => ({
      type: "assistant",
      message: {
        id,
        model,
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 100,
          cache_creation: {
            ephemeral_1h_input_tokens: oneHour ? 100 : 0,
            ephemeral_5m_input_tokens: oneHour ? 0 : 100,
          },
          output_tokens: output,
          output_tokens_details: { thinking_tokens: 3 },
        },
      },
    });
    const session = path.join(dir, "project/s1.jsonl");
    // Each content block repeats the message's usage.
    const main = [
      message("m1", "claude-opus-5-5", 40, true),
      message("m1", "claude-opus-5-5", 40, true),
      {
        type: "assistant",
        message: { id: "x", model: "<synthetic>", usage: { output_tokens: 9 } },
      },
    ];
    write(session, lines(main));
    write(
      path.join(dir, "project/s1/subagents/agent-a.jsonl"),
      lines([message("m2", "claude-sonnet-5-5", 20, false)]),
    );
    let u = sessionUsage("claude", [path.join(dir, "project")]);
    assert.equal(u.requests.length, 2);
    assert.equal(u.cost_usd, null); // no cost-state
    const p = priceUsage(u, table);
    near(
      p.cost_usd,
      (10 * 4 + 1000 * 0.2 + 100 * 8 + 40 * 20) / 1e6 +
        (10 * 2 + 1000 * 0.2 + 100 * 2.5 + 20 * 10) / 1e6,
    );
    assert.equal(p.models["claude-opus-5-5"]!.reasoning_tokens, 3);

    const state = (prompt: number) => ({
      type: "cost-state",
      sessionId: "s1",
      totalCostUSD: 0.5,
      totalAPIDuration: 4000,
      hasUnknownModelCost: false,
      modelUsage: {
        "claude-opus-5-5[1m]": {
          inputTokens: prompt,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          outputTokens: 1,
        },
      },
    });
    // A stale cost-state (fewer prompt tokens than the transcript) is ignored.
    write(session, lines([...main, state(100)]));
    assert.equal(
      sessionUsage("claude", [path.join(dir, "project")]).cost_usd,
      null,
    );
    write(session, lines([...main, state(2220)]));
    u = sessionUsage("claude", [path.join(dir, "project")]);
    assert.equal(u.cost_usd, 0.5);
    assert.deepEqual(u.seconds, { value: 4, source: "cli_api_duration" });
    assert.equal(priceUsage(u, table).cost_source, "cli_estimate");
  }));

test("pi sessions report cost per assistant message", () =>
  temporary("tikz-pi-logs-", async (dir) => {
    const msg = (cost: number) => ({
      type: "message",
      message: {
        role: "assistant",
        model: "xiaomi/mimo-v2.6-pro",
        usage: {
          input: 100,
          output: 20,
          cacheRead: 50,
          cacheWrite: 0,
          reasoning: 4,
          cost: { total: cost },
        },
      },
    });
    write(
      path.join(dir, "s.jsonl"),
      lines([
        { type: "session" },
        msg(0.01),
        { type: "message", message: { role: "user" } },
        msg(0.02),
      ]),
    );
    const p = priceUsage(sessionUsage("pi", [dir]), table);
    near(p.cost_usd, 0.03);
    assert.equal(p.cost_source, "cli_estimate");
    assert.equal(p.models["xiaomi/mimo-v2.6-pro"]!.input_tokens, 300);
  }));

test("opencode: database sessions with subagents, and exported sessions", () =>
  temporary("tikz-opencode-logs-", async (dir) => {
    const file = path.join(dir, "opencode.db"),
      db = new Database(file);
    db.run("create table session (id text primary key, parent_id text)");
    db.run(
      "create table message (id text primary key, session_id text, time_created integer, data text)",
    );
    const assistant = (cost: number) =>
      JSON.stringify({
        role: "assistant",
        modelID: "glm-5.2",
        cost,
        tokens: {
          input: 10,
          output: 5,
          reasoning: 2,
          cache: { read: 100, write: 0 },
        },
      });
    db.run(
      "insert into session values ('root', null), ('child', 'root'), ('other', null)",
    );
    db.run(
      "insert into message values ('1', 'root', 1, ?), ('2', 'child', 2, ?), ('3', 'other', 3, ?), ('4', 'root', 4, ?)",
      [
        assistant(0.1),
        assistant(0.2),
        assistant(5),
        JSON.stringify({ role: "user" }),
      ],
    );
    db.close();
    const p = priceUsage(sessionUsage("opencode", [file], "root"), table);
    near(p.cost_usd, 0.3);
    assert.equal(p.models["glm-5.2"]!.output_tokens, 14); // output + reasoning
    near(priceUsage(sessionUsage("opencode", [file]), table).cost_usd, 5.3);
    const exported = path.join(dir, "export", "root.json");
    write(
      exported,
      JSON.stringify({
        info: { id: "root" },
        messages: [{ info: JSON.parse(assistant(0.4)), parts: [] }],
      }),
    );
    near(
      priceUsage(sessionUsage("opencode", [path.dirname(exported)]), table)
        .cost_usd,
      0.4,
    );
  }));

test("kimi wire logs: every agent's requests are priced from the table", () =>
  temporary("tikz-kimi-logs-", async (dir) => {
    const record = (
      agent: string,
      other: number,
      read: number,
      output: number,
    ) => ({
      type: "usage.record",
      agentId: agent,
      model: "kimi-code/k3",
      usage: {
        inputOther: other,
        inputCacheRead: read,
        inputCacheCreation: 0,
        output,
      },
    });
    const session = path.join(dir, "wd_x/session_1/agents");
    write(
      path.join(session, "main/wire.jsonl"),
      lines([{ type: "metadata" }, record("main", 1000, 9000, 300)]),
    );
    write(
      path.join(session, "agent-1/wire.jsonl"),
      lines([record("agent-1", 500, 0, 100)]),
    );
    write(path.join(dir, "wd_x/session_1/state.json"), "{}");
    const p = priceUsage(sessionUsage("kimi", [dir]), table);
    near(p.cost_usd, (1500 * 3 + 9000 * 0.3 + 400 * 15) / 1e6);
    assert.equal(p.models["kimi-code/k3"]!.requests, 2);
    assert.deepEqual(p.unpriced, []);
  }));

test("Kimi request timing excludes tools and requires complete coverage", () =>
  temporary("tikz-kimi-timing-", async (dir) => {
    const wire = path.join(dir, "agents/main/wire.jsonl");
    const log = path.join(dir, "logs/kimi-code.log");
    const usage = {
      type: "usage.record",
      model: "kimi-code/k3",
      usage: { inputOther: 10, output: 20 },
    };
    write(wire, lines([usage, usage]));
    write(
      log,
      [
        "2026-10-03T08:00:00.000Z INFO  llm response  turnStep=0.1 ttftMs=100 streamDurationMs=200 outputTokens=20",
        "2026-10-03T08:01:00.000Z INFO  tool done durationMs=59000",
        "2026-10-03T08:01:01.000Z INFO  llm response  agentId=agent-0 ttftMs=300 streamDurationMs=400 outputTokens=20",
      ].join("\n"),
    );
    const measured = measure({ agent: "kimi", logs: [dir] });
    near(measured.wall_seconds!, 1);
    assert.equal(measured.speed_source, "cli_request_timing_logs");
    assert.equal(measured.usage.completion_tokens, 40);
    write(wire, lines([usage, usage, { type: "llm.request" }]));
    assert.equal(measure({ agent: "kimi", logs: [dir] }).wall_seconds, null);
    write(wire, lines([usage, usage]));
    write(
      log,
      "2026-10-03T08:00:00.000Z INFO  llm response  ttftMs=100 streamDurationMs=200 outputTokens=20",
    );
    assert.equal(measure({ agent: "kimi", logs: [dir] }).wall_seconds, null);
    write(
      log,
      "2026-10-03T08:00:00.000Z INFO  llm response  ttftMs=-1 streamDurationMs=200",
    );
    assert.equal(measure({ agent: "kimi", logs: [dir] }).wall_seconds, null);
  }));

test("measure: CLI totals outrank logs; logs supply usage the CLI does not print", () =>
  temporary("tikz-measure-", async (dir) => {
    // Kimi prints no usage; its wire log is the only record.
    write(
      path.join(dir, "kimi/wire.jsonl"),
      lines([
        {
          type: "usage.record",
          model: "kimi-code/k3",
          usage: {
            inputOther: 1_000_000,
            inputCacheRead: 0,
            inputCacheCreation: 0,
            output: 0,
          },
        },
      ]),
    );
    const done = lines([{ role: "assistant", content: "done" }]);
    let m = measure({
      agent: "kimi",
      stdout: done,
      logs: [path.join(dir, "kimi")],
      table,
    });
    assert.equal(m.completed, true);
    assert.equal(m.usage_source, "session_logs");
    near(m.cost_usd, 3);
    assert.equal(m.cost_source, "price_table");
    assert.equal(m.price_table_sha256, table.sha256);
    // Flat rates replace the table.
    m = measure({
      agent: "kimi",
      stdout: done,
      logs: [path.join(dir, "kimi")],
      table,
      rates: { input: 1, cached_input: 0, output: 0 },
    });
    near(m.cost_usd, 1);
    assert.equal(m.cost_source, "configured_token_rates");
    // Without logs Kimi has no usage, so no cost.
    m = measure({ agent: "kimi", stdout: done, table, model: "kimi-code/k3" });
    assert.equal(m.cost_usd, null);
    // Codex stdout totals are priced by the configured model.
    const codex = lines([
      {
        type: "turn.completed",
        usage: {
          input_tokens: 1000,
          cached_input_tokens: 0,
          output_tokens: 100,
          reasoning_output_tokens: 0,
        },
      },
    ]);
    m = measure({ agent: "codex", stdout: codex, table, model: "gpt-6-luna" });
    near(m.cost_usd, (1000 * 0.1 + 100 * 0.5) / 1e6);
    assert.equal(m.cost_source, "price_table_base_tier"); // totals: no per-request tier
    // An unpriced model leaves cost unknown and is named.
    write(
      path.join(dir, "codex/r.jsonl"),
      lines([
        { type: "turn_context", payload: { model: "gpt-x" } },
        {
          type: "token_usage_record",
          payload: {
            response_id: "a",
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ]),
    );
    m = measure({
      agent: "codex",
      stdout: codex,
      logs: [path.join(dir, "codex")],
      table,
    });
    assert.equal(m.cost_usd, null);
    assert.deepEqual(m.unpriced_models, ["gpt-x"]);
    // Claude's printed total outranks a cost computed from its logs.
    const claude = lines([
      {
        type: "result",
        subtype: "success",
        is_error: false,
        total_cost_usd: 0.07,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
    write(
      path.join(dir, "claude/s.jsonl"),
      lines([
        {
          type: "assistant",
          message: {
            id: "m",
            model: "claude-opus-5-5",
            usage: { input_tokens: 1000, output_tokens: 1000 },
          },
        },
      ]),
    );
    m = measure({
      agent: "claude",
      stdout: claude,
      logs: [path.join(dir, "claude")],
      table,
    });
    assert.equal(m.cost_usd, 0.07);
    assert.equal(m.usage.completion_tokens, 1000);
    assert.equal(m.models["claude-opus-5-5"].output_tokens, 1000);
  }));

test("--pricing accepts flat rates or a replacement price table", () =>
  temporary("tikz-pricing-", async (dir) => {
    const flat = path.join(dir, "flat.json"),
      custom = path.join(dir, "table.json"),
      bad = path.join(dir, "bad.json");
    fs.writeFileSync(
      flat,
      JSON.stringify({ input: 1, cached_input: 0.1, output: 2 }),
    );
    fs.writeFileSync(
      custom,
      JSON.stringify({
        models: { x: { input: 1, cached_input: 1, output: 1 } },
      }),
    );
    fs.writeFileSync(
      bad,
      JSON.stringify({
        models: { x: { input: -1, cached_input: 1, output: 1 } },
      }),
    );
    assert.deepEqual(loadPricing(flat).rates, {
      input: 1,
      cached_input: 0.1,
      output: 2,
    });
    assert.ok(loadPricing(custom).table.models.x);
    assert.equal(loadPricing().rates, null);
    assert.throws(() => loadPricing(bad), /nonnegative input/);
    fs.writeFileSync(bad, "null");
    assert.throws(() => loadPricing(bad), /pricing must contain/);
  }));

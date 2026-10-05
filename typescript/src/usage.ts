// Token usage, model speed and cost of an agent run, from the JSON lines a CLI
// prints and from the session logs it writes (Codex rollouts, Claude Code
// transcripts, pi sessions, the OpenCode database or export, Kimi Code wire
// logs). Cost the CLI reports is used as is; otherwise tokens are priced per
// request and model from the price table. Logs written inside an agent's
// container are agent-writable, so log-derived cost is an accounting estimate.
import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { ROOT, nonNegative, sumKnown, fileHash } from "./support.ts";
import type { RecordData } from "./support.ts";

// ---------------------------------------------------------------------------
// Standard output: one report per CLI's JSON-lines stream.

export type Telemetry = {
  /** Model response time reported by the CLI, excluding tool execution. */
  wall_seconds: number | null;
  cost_usd: number | null;
  usage: RecordData;
  speed_source: string | null;
  cost_source: string | null;
  /** The CLI reported a successful, finished run. */
  completed: boolean;
};
/** What one CLI's event stream reports, before normalization. */
type CliReport = {
  completed: boolean;
  /** Token counts in the CLI's own field names. */
  usage?: RecordData;
  cost?: number | null;
  seconds?: { value: number; source: string } | null;
};
const lastOf = (events: RecordData[], match: (e: RecordData) => unknown) =>
  events.filter(match).at(-1);

function codexReport(events: RecordData[]): CliReport {
  const turns = events.filter((e) => e.type === "turn.completed");
  const usage = turns.length
    ? Object.fromEntries(
        [
          "input_tokens",
          "cached_input_tokens",
          "output_tokens",
          "reasoning_output_tokens",
        ].map((k) => [k, sumKnown(turns.map((e) => (e.usage ?? {})[k]))]),
      )
    : undefined;
  return {
    completed:
      turns.length > 0 && !events.some((e) => e.type === "turn.failed"),
    usage,
  };
}

/** Claude Code and Cursor emit one final `result` event. */
function resultReport(events: RecordData[], claude: boolean): CliReport {
  const r = lastOf(events, (e) => e.type === "result") ?? {};
  let usage: RecordData = r.usage ?? {};
  // Claude reports cache reads/writes separately from uncached input.
  if (claude && Object.keys(usage).length)
    usage = {
      ...usage,
      input_tokens: [
        "input_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
      ].reduce((s, k) => s + (usage[k] ?? 0), 0),
    };
  return {
    completed: r.subtype === "success" && r.is_error === false,
    usage,
    cost: nonNegative(r.total_cost_usd),
    seconds:
      claude && nonNegative(r.duration_api_ms) !== null
        ? { value: r.duration_api_ms / 1000, source: "cli_api_duration" }
        : null,
  };
}

function piReport(events: RecordData[]): CliReport {
  const messages = events
      .filter(
        (e) => e.type === "message_end" && e.message?.role === "assistant",
      )
      .map((e) => e.message),
    summaries = events
      .filter(
        (e) =>
          e.type === "compaction_end" &&
          e.result &&
          typeof e.result === "object",
      )
      .map((e) => e.result),
    usages = [...messages, ...summaries].map((e) => e.usage ?? {}),
    total = (f: (u: RecordData) => number) =>
      usages.reduce((s, u) => s + f(u), 0);
  return {
    completed:
      messages.length > 0 &&
      !["error", "aborted"].includes(messages.at(-1).stopReason) &&
      events.some((e) => ["agent_end", "agent_settled"].includes(e.type)),
    usage: usages.length
      ? {
          input_tokens: total(
            (u) => (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
          ),
          output_tokens: total((u) => u.output ?? 0),
          cache_read_input_tokens: total((u) => u.cacheRead ?? 0),
        }
      : undefined,
    cost: sumKnown(usages.map((u) => u.cost?.total)),
  };
}

function opencodeReport(events: RecordData[]): CliReport {
  // Step events can repeat; count each (session, part) once.
  const steps = new Map<string, RecordData>();
  for (const e of events)
    if (e.type === "step_finish" && e.part?.id)
      steps.set(JSON.stringify([e.sessionID ?? null, e.part.id]), e.part);
  const parts = [...steps.values()],
    final =
      lastOf(events, (e) => e.type === "step_finish" && e.part)?.part ?? {};
  let usage: RecordData | undefined;
  if (parts.length) {
    const tokens = parts.map((p) => p.tokens ?? {}),
      field = (rows: RecordData[], k: string) =>
        sumKnown(rows.map((r) => r[k])),
      caches = tokens.map((t) => t.cache ?? {}),
      input = field(tokens, "input"),
      read = field(caches, "read"),
      write = field(caches, "write"),
      output = field(tokens, "output"),
      reasoning = field(tokens, "reasoning");
    usage = {
      input_tokens:
        input !== null && read !== null && write !== null
          ? input + read + write
          : null,
      output_tokens:
        output !== null && reasoning !== null ? output + reasoning : null,
      cached_input_tokens: read,
      reasoning_output_tokens: reasoning,
    };
  }
  return {
    completed:
      steps.size > 0 &&
      ["stop", "end-turn"].includes(final.reason) &&
      !events.some((e) => e.type === "error"),
    usage,
    cost: sumKnown(parts.map((p) => p.cost)),
  };
}

/** Kimi Code's stream-json carries no usage; see its wire logs instead. */
function kimiReport(events: RecordData[]): CliReport {
  const last = lastOf(events, (e) => ["assistant", "tool"].includes(e.role));
  return {
    completed:
      !!last &&
      last.role === "assistant" &&
      !last.tool_calls?.length &&
      !events.some((e) => e.type === "error" || e.role === "error"),
  };
}

function antigravityReport(events: RecordData[]): CliReport {
  const r =
    lastOf(events, (e) => e.event === "result" && e.result)?.result ?? {};
  // Sum the model's response steps; each step can be reported repeatedly.
  const steps = new Map<string, unknown>();
  for (const e of events) {
    const s = e.step_update ?? {};
    if (
      e.event === "step_update" &&
      s.state === "DONE" &&
      s.step_type === "agent_response"
    )
      steps.set(
        JSON.stringify([s.conversation_id ?? null, s.step_index ?? null]),
        s.duration_seconds,
      );
  }
  const seconds = sumKnown([...steps.values()]);
  return {
    completed: r.status === "SUCCESS",
    usage: r.usage ?? {},
    seconds:
      seconds === null
        ? null
        : { value: seconds, source: "cli_model_response_steps" },
  };
}

const REPORTS: Record<string, (events: RecordData[]) => CliReport> = {
  codex: codexReport,
  claude: (events) => resultReport(events, true),
  cursor: (events) => resultReport(events, false),
  pi: piReport,
  opencode: opencodeReport,
  kimi: kimiReport,
  antigravity: antigravityReport,
};

/** Flat USD-per-million-token rates (`--pricing`), applied to every model. */
export type TokenRates = {
  input: number;
  cached_input: number;
  output: number;
};

const jsonLines = (text: string) => {
  const rows: RecordData[] = [];
  for (const line of text.split("\n"))
    try {
      const v = JSON.parse(line);
      if (v && typeof v === "object" && !Array.isArray(v)) rows.push(v);
    } catch {}
  return rows;
};

/**
 * Completion, speed, usage and cost from a CLI's JSON-lines output. Values the
 * CLI does not report stay null; configured token rates estimate missing cost.
 */
export function telemetry(
  agent: string,
  stdout: string,
  rates?: TokenRates | null,
): Telemetry {
  const report = REPORTS[agent]?.(jsonLines(stdout)) ?? { completed: false },
    u = report.usage ?? {},
    cost = report.cost ?? null;
  const m: Telemetry = {
    wall_seconds: report.seconds?.value ?? null,
    cost_usd: cost,
    usage: {},
    speed_source: report.seconds?.source ?? null,
    cost_source: cost === null ? null : "cli_estimate",
    completed: report.completed,
  };
  if (Object.keys(u).length)
    m.usage = {
      prompt_tokens: nonNegative(u.input_tokens),
      completion_tokens: nonNegative(u.output_tokens),
      cached_prompt_tokens: nonNegative(
        u.cached_input_tokens ??
          u.cache_read_input_tokens ??
          u.cache_read_tokens,
      ),
      completion_tokens_details: {
        reasoning_tokens: nonNegative(
          u.reasoning_output_tokens ?? u.thinking_tokens,
        ),
      },
    };
  if (m.cost_usd === null && rates && Object.keys(m.usage).length) {
    const {
      prompt_tokens: input,
      completion_tokens: output,
      cached_prompt_tokens: cached,
    } = m.usage;
    if (
      input !== null &&
      output !== null &&
      cached !== null &&
      cached <= input
    ) {
      m.cost_usd = flatCost(rates, input, cached, output);
      m.cost_source = "configured_token_rates";
    }
  }
  return m;
}

const flatCost = (
  r: TokenRates,
  input: number,
  cached: number,
  output: number,
) =>
  ((input - cached) * r.input + cached * r.cached_input + output * r.output) /
  1e6;

// ---------------------------------------------------------------------------
// Session logs: per-request usage in one normalized shape.

/**
 * Tokens of one model request. `input` counts every prompt token, including
 * cache reads and writes; `output` includes reasoning.
 */
export type Request = {
  model: string;
  input: number;
  cached_input: number;
  cache_write: number;
  /** Part of `cache_write` stored for an hour (Claude's longer cache). */
  cache_write_1h: number;
  output: number;
  reasoning: number | null;
  /** Cost the CLI reported for this request, if any. */
  cost_usd?: number | null;
  /** Totals over several requests: tiered prices cannot be applied exactly. */
  aggregate?: boolean;
};
export type LogUsage = {
  requests: Request[];
  /** Session cost the CLI reported, when it covers every request. */
  cost_usd: number | null;
  seconds: { value: number; source: string } | null;
  files: string[];
};

const n = (v: unknown) => nonNegative(v) ?? 0;
const request = (model: string, r: Partial<Request>): Request => ({
  model,
  input: 0,
  cached_input: 0,
  cache_write: 0,
  cache_write_1h: 0,
  output: 0,
  reasoning: null,
  ...r,
});

/** Codex rollouts: one token_usage_record per response, else running totals. */
function codexLog(files: RecordData[][]): Omit<LogUsage, "files"> {
  const requests: Request[] = [],
    seen = new Set<string>();
  for (const rows of files) {
    let model = "unknown",
      total: RecordData | null = null,
      records = 0;
    for (const e of rows) {
      const p = e.payload ?? {};
      if (e.type === "turn_context" && p.model) model = p.model;
      if (e.type === "token_usage_record" && p.usage) {
        records++;
        const id = p.response_id ?? JSON.stringify([p.turn_id, e.ordinal]);
        if (seen.has(id)) continue; // copied into a resumed or forked session
        seen.add(id);
        requests.push(codexRequest(model, p.usage));
      }
      if (e.type === "event_msg" && p.type === "token_count" && p.info)
        total = { model, usage: p.info.total_token_usage };
    }
    if (!records && total?.usage)
      requests.push({
        ...codexRequest(total.model, total.usage),
        aggregate: true,
      });
  }
  return { requests, cost_usd: null, seconds: null };
}
const codexRequest = (model: string, u: RecordData) =>
  request(model, {
    input: n(u.input_tokens),
    cached_input: n(u.cached_input_tokens),
    cache_write: n(u.cache_write_input_tokens),
    output: n(u.output_tokens),
    reasoning: nonNegative(u.reasoning_output_tokens),
  });

/**
 * Claude Code transcripts (including subagents/*.jsonl). Each content block
 * repeats its message's usage, so messages are counted once by ID. The CLI's
 * cost-state, when current, gives the session cost and API time; it also
 * covers side requests (such as titles) that have no transcript message.
 */
function claudeLog(files: RecordData[][]): Omit<LogUsage, "files"> {
  const messages = new Map<string, Request>(),
    states = new Map<string, RecordData>();
  for (const rows of files)
    for (const e of rows) {
      if (e.type === "cost-state" && e.sessionId) states.set(e.sessionId, e);
      const m = e.message;
      if (e.type !== "assistant" || !m?.usage || m.model === "<synthetic>")
        continue;
      const u = m.usage,
        read = n(u.cache_read_input_tokens),
        write = n(u.cache_creation_input_tokens);
      messages.set(
        m.id ?? e.uuid,
        request(m.model ?? "unknown", {
          input: n(u.input_tokens) + read + write,
          cached_input: read,
          cache_write: write,
          cache_write_1h: n(u.cache_creation?.ephemeral_1h_input_tokens),
          output: n(u.output_tokens),
          reasoning: nonNegative(u.output_tokens_details?.thinking_tokens),
        }),
      );
    }
  // Transcripts can miss the final output count of subagent messages, but
  // record prompt tokens reliably: a cost-state covering at least the
  // transcript's prompt tokens is current, and its CLI cost is authoritative.
  const requests = [...messages.values()],
    prompt = requests.reduce((s, r) => s + r.input, 0),
    statePrompt = [...states.values()].reduce(
      (s, st) =>
        s +
        Object.values<RecordData>(st.modelUsage ?? {}).reduce(
          (t, mu) =>
            t +
            n(mu.inputTokens) +
            n(mu.cacheReadInputTokens) +
            n(mu.cacheCreationInputTokens),
          0,
        ),
      0,
    ),
    complete =
      states.size > 0 &&
      statePrompt >= prompt &&
      [...states.values()].every(
        (st) =>
          nonNegative(st.totalCostUSD) !== null && !st.hasUnknownModelCost,
      );
  return {
    requests,
    cost_usd: complete
      ? [...states.values()].reduce((s, st) => s + st.totalCostUSD, 0)
      : null,
    seconds: complete
      ? {
          value:
            [...states.values()].reduce(
              (s, st) => s + n(st.totalAPIDuration),
              0,
            ) / 1000,
          source: "cli_api_duration",
        }
      : null,
  };
}

/** pi sessions: assistant messages and compaction summaries carry cost. */
function piLog(files: RecordData[][]): Omit<LogUsage, "files"> {
  const requests: Request[] = [];
  for (const rows of files)
    for (const e of rows) {
      const m = e.type === "message" ? e.message : e;
      if (
        !(m?.role === "assistant" || e.type === "compaction") ||
        !m.usage ||
        typeof m.usage !== "object"
      )
        continue;
      const u = m.usage,
        read = n(u.cacheRead),
        write = n(u.cacheWrite);
      requests.push(
        request(m.model ?? "unknown", {
          input: n(u.input) + read + write,
          cached_input: read,
          cache_write: write,
          output: n(u.output),
          reasoning: nonNegative(u.reasoning),
          cost_usd: nonNegative(u.cost?.total),
        }),
      );
    }
  return { requests, cost_usd: null, seconds: null };
}

/** OpenCode assistant messages, from its database or `opencode export`. */
function opencodeMessages(messages: RecordData[]): Omit<LogUsage, "files"> {
  const requests = messages
    .filter((m) => m?.role === "assistant" && m.tokens)
    .map((m) => {
      const t = m.tokens,
        read = n(t.cache?.read),
        write = n(t.cache?.write);
      return request(m.modelID ?? "unknown", {
        input: n(t.input) + read + write,
        cached_input: read,
        cache_write: write,
        output: n(t.output) + n(t.reasoning),
        reasoning: nonNegative(t.reasoning),
        cost_usd: nonNegative(m.cost),
      });
    });
  return { requests, cost_usd: null, seconds: null };
}

/** Kimi Code wire logs: one usage.record per model request, per agent. */
function kimiLog(files: RecordData[][]): Omit<LogUsage, "files"> {
  const requests: Request[] = [];
  for (const rows of files)
    for (const e of rows) {
      if (e.type !== "usage.record" || !e.usage) continue;
      const u = e.usage,
        read = n(u.inputCacheRead),
        write = n(u.inputCacheCreation);
      requests.push(
        request(e.model ?? "unknown", {
          input: n(u.inputOther) + read + write,
          cached_input: read,
          cache_write: write,
          output: n(u.output),
        }),
      );
    }
  return { requests, cost_usd: null, seconds: null };
}

const LOG_FILES: Record<string, (name: string) => boolean> = {
  codex: (f) => f.endsWith(".jsonl"),
  claude: (f) => f.endsWith(".jsonl"),
  pi: (f) => f.endsWith(".jsonl"),
  kimi: (f) => ["wire.jsonl", "kimi-code.log"].includes(path.basename(f)),
  opencode: (f) => /\.(db|json)$/.test(f),
};
export const LOG_AGENTS = Object.keys(LOG_FILES);

/** Regular files under `paths` that hold `agent` session logs, sorted. */
function logFiles(agent: string, paths: string[]) {
  const out: string[] = [];
  const walk = (p: string) => {
    const s = fs.lstatSync(p);
    if (s.isDirectory())
      for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e));
    else if (s.isFile() && LOG_FILES[agent]!(p)) out.push(p);
  };
  for (const p of paths) walk(p);
  return out;
}

/**
 * Usage recorded in `agent` session logs at `paths` (files or directories).
 * `session` selects one OpenCode session (and its subagent sessions) in a
 * database holding several.
 */
export function sessionUsage(
  agent: string,
  paths: string[],
  session?: string,
): LogUsage {
  if (!LOG_FILES[agent]) throw Error(agent + " has no supported session logs");
  const files = logFiles(agent, paths);
  if (!files.length) throw Error("no " + agent + " session logs found");
  const read = () => files.map((f) => jsonLines(fs.readFileSync(f, "utf8")));
  let usage: Omit<LogUsage, "files">;
  if (agent === "opencode")
    usage = opencodeMessages(opencodeRows(files, session));
  else
    usage = { codex: codexLog, claude: claudeLog, pi: piLog, kimi: kimiLog }[
      agent
    ]!(read());
  if (agent === "kimi") {
    // Kimi 2.1 logs explicit request latency and streaming duration separately
    // from tool execution. Require a timing record for every usage record;
    // older clients and incomplete logs must not produce partial totals.
    const timings: number[] = [];
    for (const file of files.filter(
      (f) => path.basename(f) === "kimi-code.log",
    ))
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        const m =
          /^\S+ INFO\s+llm response\s+.*?\bttftMs=(\d+)\s+streamDurationMs=(\d+)\b/.exec(
            line,
          );
        if (m) timings.push((Number(m[1]) + Number(m[2])) / 1000);
      }
    const started = read()
      .flat()
      .filter((e) => e.type === "llm.request").length;
    if (
      timings.length &&
      timings.length === usage.requests.length &&
      (!started || started === usage.requests.length)
    )
      usage.seconds = {
        value: timings.reduce((s, n) => s + n, 0),
        source: "cli_request_timing_logs",
      };
  }
  return { ...usage, files };
}

function opencodeRows(files: string[], session?: string) {
  const rows: RecordData[] = [];
  for (const f of files) {
    if (f.endsWith(".json")) {
      const doc = JSON.parse(fs.readFileSync(f, "utf8"));
      if (!session || doc.info?.id === session)
        rows.push(...(doc.messages ?? []).map((m: RecordData) => m.info ?? m));
      continue;
    }
    const db = new Database(f, { readonly: true });
    try {
      const ids = session
        ? db
            .query(
              `with recursive tree(id) as (select ?1 union
               select s.id from session s join tree t on s.parent_id = t.id)
               select id from tree`,
            )
            .all(session)
            .map((r: any) => r.id)
        : null;
      const all = db
        .query("select session_id, data from message order by time_created, id")
        .all() as { session_id: string; data: string }[];
      for (const r of all)
        if (!ids || ids.includes(r.session_id)) rows.push(JSON.parse(r.data));
    } finally {
      db.close();
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Prices

type Tier = {
  input: number;
  cached_input: number;
  /** Default cache write (OpenAI 30 minutes, Kimi and Claude 5 minutes). */
  cache_write?: number | null;
  cache_write_1h?: number | null;
  output: number;
};
type Price = Tier & {
  /** Prices for a request whose prompt exceeds `threshold_tokens`. */
  long_context?: (Tier & { threshold_tokens: number }) | null;
};
export type PriceTable = {
  models: Record<string, Price & RecordData>;
  aliases?: Record<string, string>;
  sha256?: string;
};
export const PRICE_TABLE = path.join(ROOT, "typescript/pricing.json");

export function loadPrices(file = PRICE_TABLE): PriceTable {
  const table = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const [model, p] of Object.entries<RecordData>(table.models ?? {}))
    for (const k of ["input", "cached_input", "output"])
      if (nonNegative(p[k]) === null)
        throw Error(`price table: ${model} needs a nonnegative ${k} price`);
  return { ...table, sha256: fileHash(file) };
}

/** The table entry for a model ID as a CLI logs it, or null. */
export function priceOf(table: PriceTable, model: string): Price | null {
  const candidates = [model, model.replace(/\[1m\]$/, "")];
  for (const c of [...candidates]) candidates.push(c.replace(/^[\w.-]+\//, "")); // provider/model -> model
  for (const c of candidates) {
    const id = table.aliases?.[c] ?? c;
    if (table.models[id]) return table.models[id];
  }
  return null;
}

/** USD for one request; tiers apply to the request's prompt size. */
export function requestCost(price: Price, r: Request) {
  const tier =
    price.long_context && r.input > price.long_context.threshold_tokens
      ? price.long_context
      : price;
  const write = tier.cache_write ?? tier.input,
    write1h = tier.cache_write_1h ?? write,
    uncached = r.input - r.cached_input - r.cache_write;
  if (uncached < 0) throw Error("cached tokens exceed input tokens");
  return (
    (uncached * tier.input +
      r.cached_input * tier.cached_input +
      (r.cache_write - r.cache_write_1h) * write +
      r.cache_write_1h * write1h +
      r.output * tier.output) /
    1e6
  );
}

// ---------------------------------------------------------------------------
// Summaries for task records

export type ModelTotals = {
  requests: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number | null;
  cost_usd: number | null;
  cost_source: string | null;
};

/** Per-model totals and costs: CLI-reported, else priced, else null. */
export function priceUsage(
  usage: LogUsage,
  table: PriceTable | null,
  rates?: TokenRates | null,
) {
  const models: Record<string, ModelTotals> = {};
  const unpriced = new Set<string>();
  for (const r of usage.requests) {
    const t = (models[r.model] ??= {
      requests: 0,
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 0,
      reasoning_tokens: 0,
      cost_usd: 0,
      cost_source: null,
    });
    t.requests += r.aggregate ? 0 : 1;
    t.input_tokens += r.input;
    t.cached_input_tokens += r.cached_input;
    t.cache_write_tokens += r.cache_write;
    t.output_tokens += r.output;
    t.reasoning_tokens =
      t.reasoning_tokens === null || r.reasoning === null
        ? null
        : t.reasoning_tokens + r.reasoning;
    let cost: number | null = null,
      source: string | null = null;
    const price = table && priceOf(table, r.model);
    if (r.cost_usd != null) [cost, source] = [r.cost_usd, "cli_estimate"];
    else if (rates)
      [cost, source] = [
        flatCost(rates, r.input, r.cached_input, r.output),
        "configured_token_rates",
      ];
    else if (price) {
      cost = requestCost(price, r);
      source =
        price.long_context && r.aggregate
          ? "price_table_base_tier"
          : "price_table";
    } else unpriced.add(r.model);
    t.cost_usd =
      t.cost_usd === null || cost === null ? null : t.cost_usd + cost;
    t.cost_source =
      t.cost_source && source && t.cost_source !== source
        ? "mixed"
        : (t.cost_source ?? source);
  }
  const costs = Object.values(models).map((m) => m.cost_usd);
  let cost = costs.length ? sumKnown(costs) : null,
    source = [...new Set(Object.values(models).map((m) => m.cost_source))];
  if (usage.cost_usd !== null) {
    cost = usage.cost_usd;
    source = ["cli_estimate"];
  }
  return {
    models,
    cost_usd: cost,
    cost_source:
      cost === null ? null : source.length === 1 ? source[0]! : "mixed",
    unpriced: [...unpriced].sort(),
  };
}

/**
 * Accounting for one agent run: completion and stdout usage, superseded by
 * session-log usage when logs are available (Kimi prints none; logs also
 * include subagents). Cost: CLI-reported, then `rates`, then the price table.
 */
export function measure({
  agent,
  stdout = "",
  logs = [],
  session,
  model,
  rates = null,
  table = null,
}: {
  agent: string;
  stdout?: string;
  logs?: string[];
  session?: string;
  /** The configured model, for pricing stdout-only usage. */
  model?: string;
  rates?: TokenRates | null;
  table?: PriceTable | null;
}): Telemetry & RecordData {
  const out: Telemetry & RecordData = telemetry(agent, stdout, rates);
  let log: LogUsage | null = null;
  if (logs.length && LOG_FILES[agent])
    try {
      log = sessionUsage(agent, logs, session);
    } catch {}
  if (log?.requests.length) {
    const priced = priceUsage(log, table, rates),
      t = Object.values(priced.models);
    out.usage = {
      prompt_tokens: t.reduce((s, m) => s + m.input_tokens, 0),
      completion_tokens: t.reduce((s, m) => s + m.output_tokens, 0),
      cached_prompt_tokens: t.reduce((s, m) => s + m.cached_input_tokens, 0),
      completion_tokens_details: {
        reasoning_tokens: t.some((m) => m.reasoning_tokens === null)
          ? null
          : t.reduce((s, m) => s + m.reasoning_tokens!, 0),
      },
    };
    out.models = priced.models;
    out.usage_source = "session_logs";
    // A total the CLI printed outranks one computed from its logs.
    if (out.cost_source !== "cli_estimate") {
      out.cost_usd = priced.cost_usd;
      out.cost_source = priced.cost_source;
    }
    if (out.wall_seconds === null && log.seconds) {
      out.wall_seconds = log.seconds.value;
      out.speed_source = log.seconds.source;
    }
    if (priced.unpriced.length) out.unpriced_models = priced.unpriced;
  } else if (Object.keys(out.usage).length) {
    out.usage_source = "stdout";
    const u = out.usage,
      price = table && model ? priceOf(table, model) : null;
    if (
      out.cost_usd === null &&
      price &&
      u.prompt_tokens !== null &&
      u.completion_tokens !== null &&
      u.cached_prompt_tokens !== null
    ) {
      // Totals only: a long-context tier cannot be applied per request.
      out.cost_usd = requestCost(
        price,
        request(model!, {
          input: u.prompt_tokens,
          cached_input: u.cached_prompt_tokens,
          output: u.completion_tokens,
        }),
      );
      out.cost_source = price.long_context
        ? "price_table_base_tier"
        : "price_table";
    }
  }
  if (table?.sha256 && out.cost_source?.startsWith("price_table"))
    out.price_table_sha256 = table.sha256;
  return out;
}

// Subscription logins for coding agents and the judging panel. Only the token
// fields each CLI needs are imported; host settings and API keys never are.
import path from "node:path";
import os from "node:os";
import { parse as parseTOML } from "@iarna/toml";
import { readRegular, same, nonNegative } from "./support.ts";
import type { RecordData } from "./support.ts";
import { capture } from "./process.ts";

export const SUBSCRIPTION_AGENTS = new Set(["codex", "claude", "kimi"]);
export type AuthMode = "subscription" | "api";

/** Subscription by default where supported; never a silent fallback. */
export function authMode(agent: string, requested?: string): AuthMode {
  const mode =
    requested ?? (SUBSCRIPTION_AGENTS.has(agent) ? "subscription" : "api");
  if (
    (mode !== "subscription" && mode !== "api") ||
    (mode === "subscription" && !SUBSCRIPTION_AGENTS.has(agent))
  )
    throw Error("unsupported authentication mode");
  return mode;
}

export function readPrivate(p: string) {
  try {
    return readRegular(p);
  } catch {
    throw Error(
      "subscription credential file is missing, unreadable or invalid; sign in again",
    );
  }
}

function object(raw: string): RecordData {
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
  } catch {}
  throw Error("invalid subscription credential JSON; sign in again");
}

const pick = (v: RecordData, keys: string[]) =>
  Object.fromEntries(Object.entries(v).filter(([k]) => keys.includes(k)));
const isTokenKey = (k: string) => k.toLowerCase().includes("token");

/**
 * How a worker's refreshed credential cache may update the imported one:
 * which object holds the tokens, which fields may change, and which must exist.
 */
type RefreshRule = {
  section: (v: RecordData) => RecordData | undefined;
  fields: string[];
  required: string;
  /** Reject account or method changes; may copy extra metadata. */
  check?: (before: RecordData, after: RecordData) => void;
};
const CODEX_REFRESH: RefreshRule = {
  section: (v) => v.tokens,
  fields: ["access_token", "refresh_token", "id_token"],
  required: "access_token",
  check(before, after) {
    if (
      after.auth_mode !== "chatgpt" ||
      after.OPENAI_API_KEY ||
      !after.tokens ||
      after.tokens.account_id !== before.tokens.account_id
    )
      throw Error(
        "worker changed subscription account or authentication method",
      );
    if (
      typeof after.last_refresh === "string" &&
      after.last_refresh.length < 100
    )
      before.last_refresh = after.last_refresh;
  },
};
const CLAUDE_REFRESH: RefreshRule = {
  section: (v) => v.claudeAiOauth,
  fields: ["accessToken", "refreshToken", "expiresAt", "refreshTokenExpiresAt"],
  required: "accessToken",
};
const KIMI_REFRESH: RefreshRule = {
  section: (v) => v,
  fields: ["access_token", "refresh_token", "expires_at", "expires_in"],
  required: "access_token",
};
const refreshRule = (file: string) =>
  file.endsWith("/.codex/auth.json")
    ? CODEX_REFRESH
    : file.endsWith("/.claude/.credentials.json")
      ? CLAUDE_REFRESH
      : KIMI_REFRESH;

/**
 * Imported subscription credentials. `files` are private credential caches
 * written into the worker (paths under /agent-home); `publicFiles` are
 * non-secret CLI configuration; `env` holds token variables.
 */
export class SubscriptionAuth {
  readonly source: string;
  files: Record<string, string>;
  readonly env: Record<string, string>;
  readonly publicFiles: Record<string, string>;
  /** Set once credentials can no longer be trusted; stops further runs. */
  error: string | null = null;
  /** Every token seen, for redaction from logs and replies. */
  readonly secrets: string[] = [];
  constructor(
    source: string,
    files: Record<string, string> = {},
    env: Record<string, string> = {},
    publicFiles: Record<string, string> = {},
  ) {
    this.source = source;
    this.files = files;
    this.env = env;
    this.publicFiles = publicFiles;
    const collect = (v: unknown, key = "") => {
      if (v && typeof v === "object")
        for (const [k, s] of Object.entries(v)) collect(s, k);
      else if (
        typeof v === "string" &&
        v &&
        (isTokenKey(key) || key === "account_id")
      )
        this.secrets.push(v);
    };
    for (const raw of Object.values(files)) collect(object(raw));
    this.secrets.push(...Object.values(env));
  }

  /** Accept token refreshes from a worker; reject any other change. */
  acceptRefresh(files: Record<string, string>) {
    if (
      !files ||
      !same(Object.keys(files).sort(), Object.keys(this.files).sort())
    )
      throw Error("worker did not return the subscription credential cache");
    const updated: Record<string, string> = {};
    for (const [file, raw] of Object.entries(files)) {
      const rule = refreshRule(file),
        before = object(this.files[file]),
        after = object(raw);
      rule.check?.(before, after);
      const original = rule.section(before)!,
        refreshed = rule.section(after);
      if (
        !refreshed ||
        typeof refreshed[rule.required] !== "string" ||
        !refreshed[rule.required]
      )
        throw Error("invalid refreshed subscription credential cache");
      for (const key of rule.fields) {
        if (!(key in refreshed)) continue;
        const v = refreshed[key];
        if (isTokenKey(key) && typeof v !== "string")
          throw Error("invalid refreshed subscription token");
        if (key.toLowerCase().includes("expire") && nonNegative(v) === null)
          throw Error("invalid refreshed subscription expiration");
        if (isTokenKey(key) && v) this.secrets.push(v);
        original[key] = v;
      }
      updated[file] = JSON.stringify(before);
    }
    this.files = updated;
  }
}

async function loadCodex(authPath?: string) {
  const data = object(
      readPrivate(
        authPath ??
          path.join(
            process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
            "auth.json",
          ),
      ),
    ),
    tokens = data.tokens;
  if (
    ![undefined, null, "chatgpt"].includes(data.auth_mode) ||
    data.OPENAI_API_KEY ||
    !tokens?.access_token
  )
    throw Error("Codex requires ChatGPT login; sign in with codex login");
  const chosen = pick(tokens, [
    "id_token",
    "access_token",
    "refresh_token",
    "account_id",
  ]);
  if (Object.values(chosen).some((v) => typeof v !== "string"))
    throw Error("invalid Codex ChatGPT credentials");
  const clean = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: chosen,
    ...(typeof data.last_refresh === "string"
      ? { last_refresh: data.last_refresh }
      : {}),
  };
  return new SubscriptionAuth("codex_chatgpt_cache", {
    "/agent-home/.codex/auth.json": JSON.stringify(clean),
  });
}

/** macOS Keychain entry written by `claude auth login`, if readable. */
async function claudeKeychain() {
  if (process.platform !== "darwin") return undefined;
  try {
    const r = await capture(
      [
        "security",
        "find-generic-password",
        "-s",
        "Claude Code-credentials",
        "-w",
      ],
      { timeout: 10 },
    );
    if (!r.returncode && !r.error) return r.stdout;
  } catch {}
  return undefined;
}

async function loadClaude(authPath?: string) {
  const token = authPath ? undefined : process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (token) {
    if (!token.startsWith("sk-ant-oat"))
      throw Error("CLAUDE_CODE_OAUTH_TOKEN must come from claude setup-token");
    return new SubscriptionAuth(
      "claude_subscription_token",
      {},
      { CLAUDE_CODE_OAUTH_TOKEN: token },
    );
  }
  const keychain = authPath ? undefined : await claudeKeychain(),
    raw =
      keychain ??
      readPrivate(
        authPath ??
          path.join(
            process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
            ".credentials.json",
          ),
      );
  const oauth = object(raw).claudeAiOauth;
  if (!oauth?.accessToken)
    throw Error(
      "Claude subscription login missing; run claude auth login or claude setup-token",
    );
  const clean = pick(oauth, [
    "accessToken",
    "refreshToken",
    "expiresAt",
    "refreshTokenExpiresAt",
    "scopes",
    "subscriptionType",
    "rateLimitTier",
  ]);
  if (
    ["accessToken", "refreshToken"].some(
      (k) => k in clean && typeof clean[k] !== "string",
    )
  )
    throw Error("invalid Claude subscription credentials");
  return new SubscriptionAuth(
    keychain === undefined ? "claude_oauth_file" : "claude_oauth_keychain",
    {
      "/agent-home/.claude/.credentials.json": JSON.stringify({
        claudeAiOauth: clean,
      }),
    },
  );
}

/** Kimi's managed OAuth endpoints and their matching authorization hosts. */
const KIMI_HOSTS: Record<string, string> = {
  "https://api.kimi.com/coding/v1": "https://auth.kimi.com",
  "https://api.kimi.ai/coding/v1": "https://auth.kimi.ai",
};

async function loadKimi(model: string, authPath?: string) {
  const root =
    authPath ??
    process.env.KIMI_CODE_HOME ??
    path.join(os.homedir(), ".kimi-code");
  let config: RecordData;
  try {
    config = parseTOML(readPrivate(path.join(root, "config.toml")));
  } catch {
    throw Error("invalid Kimi login configuration; run kimi login");
  }
  const provider = config.providers?.["managed:kimi-code"] ?? {},
    oauth = provider.oauth ?? {},
    key = oauth.key ?? "",
    endpoint = (provider.base_url ?? "").replace(/\/+$/, ""),
    host = KIMI_HOSTS[endpoint];
  if (
    provider.type !== "kimi" ||
    !host ||
    oauth.storage !== "file" ||
    !/^oauth\/[A-Za-z0-9_-]+$/.test(key) ||
    (oauth.oauth_host ?? host) !== host
  )
    throw Error("Kimi requires its managed subscription login; run kimi login");
  const name = key.split("/")[1] + ".json",
    data = object(readPrivate(path.join(root, "credentials", name)));
  if (typeof data.access_token !== "string" || !data.access_token)
    throw Error("Kimi subscription token missing; run kimi login");
  const selected =
    config.models?.[model] ?? config.models?.["kimi-code/" + model];
  if (
    selected?.provider !== "managed:kimi-code" ||
    typeof selected.model !== "string" ||
    !Number.isSafeInteger(selected.max_context_size)
  )
    throw Error("select a model from the Kimi subscription aliases");
  const q = JSON.stringify;
  const settings = `default_model = ${q(model)}
telemetry = false
[providers."managed:kimi-code"]
type = "kimi"
base_url = ${q(endpoint)}
[providers."managed:kimi-code".oauth]
storage = "file"
key = ${q(key)}
oauth_host = ${q(host)}
[models.${q(model)}]
provider = "managed:kimi-code"
model = ${q(selected.model)}
max_context_size = ${selected.max_context_size}
capabilities = ["image_in", "thinking", "tool_use"]
`;
  const credentials = pick(data, [
    "access_token",
    "refresh_token",
    "expires_at",
    "scope",
    "token_type",
    "expires_in",
  ]);
  return new SubscriptionAuth(
    "kimi_managed_oauth",
    { ["/agent-home/.kimi-code/credentials/" + name]: q(credentials) },
    {},
    {
      "/agent-home/.kimi-code/config.toml": settings,
      "/agent-home/empty-skills/.keep": "",
    },
  );
}

/** Import the host's native subscription login for `agent`. */
export async function loadSubscription(
  agent: string,
  model: string,
  authPath?: string,
): Promise<SubscriptionAuth> {
  if (agent === "codex") return await loadCodex(authPath);
  if (agent === "claude") return await loadClaude(authPath);
  if (agent === "kimi") return await loadKimi(model, authPath);
  throw Error("subscription authentication is not implemented for " + agent);
}

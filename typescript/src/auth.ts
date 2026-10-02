import path from "node:path";
import os from "node:os";
import { parse as parseTOML } from "@iarna/toml";
import { readRegular, capture, same, number } from "./support.ts";
import type { RecordData } from "./support.ts";
export const SUBSCRIPTION_AGENTS = new Set(["codex", "claude", "kimi"]);
export function authMode(agent: string, requested?: string) {
  const mode =
    requested ?? (SUBSCRIPTION_AGENTS.has(agent) ? "subscription" : "api");
  if (
    !["subscription", "api"].includes(mode) ||
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
export class SubscriptionAuth {
  source: string;
  files: Record<string, string>;
  env: Record<string, string>;
  publicFiles: Record<string, string>;
  error: string | null = null;
  secrets: string[] = [];
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
    const collect = (v: any, key = "") => {
      if (v && typeof v === "object") {
        for (const [k, s] of Object.entries(v)) collect(s, k);
      } else if (
        typeof v === "string" &&
        v &&
        (key.toLowerCase().includes("token") || key === "account_id")
      )
        this.secrets.push(v);
    };
    Object.values(files).forEach((raw) => collect(object(raw)));
    this.secrets.push(...Object.values(env));
  }
  acceptRefresh(files: Record<string, string>) {
    if (
      !files ||
      !same(Object.keys(files).sort(), Object.keys(this.files).sort())
    )
      throw Error("worker did not return the subscription credential cache");
    const updated: Record<string, string> = {};
    for (const [p, raw] of Object.entries(files)) {
      const before = object(this.files[p]),
        after = object(raw);
      let original: RecordData,
        refreshed: RecordData,
        fields: string[],
        required: string;
      if (p.endsWith("/.codex/auth.json")) {
        if (
          after.auth_mode !== "chatgpt" ||
          after.OPENAI_API_KEY ||
          !after.tokens ||
          after.tokens.account_id !== before.tokens.account_id
        )
          throw Error(
            "worker changed subscription account or authentication method",
          );
        original = before.tokens;
        refreshed = after.tokens;
        fields = ["access_token", "refresh_token", "id_token"];
        required = "access_token";
        if (
          typeof after.last_refresh === "string" &&
          after.last_refresh.length < 100
        )
          before.last_refresh = after.last_refresh;
      } else if (p.endsWith("/.claude/.credentials.json")) {
        original = before.claudeAiOauth;
        refreshed = after.claudeAiOauth;
        fields = [
          "accessToken",
          "refreshToken",
          "expiresAt",
          "refreshTokenExpiresAt",
        ];
        required = "accessToken";
      } else {
        original = before;
        refreshed = after;
        fields = ["access_token", "refresh_token", "expires_at", "expires_in"];
        required = "access_token";
      }
      if (
        !refreshed ||
        typeof refreshed[required] !== "string" ||
        !refreshed[required]
      )
        throw Error("invalid refreshed subscription credential cache");
      for (const key of fields) {
        if (!(key in refreshed)) continue;
        const v = refreshed[key];
        if (key.toLowerCase().includes("token") && typeof v !== "string")
          throw Error("invalid refreshed subscription token");
        if (key.toLowerCase().includes("expire") && number(v) === null)
          throw Error("invalid refreshed subscription expiration");
        if (key.toLowerCase().includes("token") && v) this.secrets.push(v);
        original[key] = v;
      }
      updated[p] = JSON.stringify(before);
    }
    this.files = updated;
  }
}
const select = (v: RecordData, keys: string[]) =>
  Object.fromEntries(Object.entries(v).filter(([k]) => keys.includes(k)));
export async function loadSubscription(
  agent: string,
  model: string,
  authPath?: string,
): Promise<SubscriptionAuth> {
  if (agent === "codex") {
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
    const chosen = select(tokens, [
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
  if (agent === "claude") {
    const token = authPath ? undefined : process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (token) {
      if (!token.startsWith("sk-ant-oat"))
        throw Error(
          "CLAUDE_CODE_OAUTH_TOKEN must come from claude setup-token",
        );
      return new SubscriptionAuth(
        "claude_subscription_token",
        {},
        { CLAUDE_CODE_OAUTH_TOKEN: token },
      );
    }
    let raw: string | undefined,
      source = "claude_oauth_file";
    if (!authPath && process.platform === "darwin") {
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
        if (!r.returncode && !r.error) {
          raw = r.stdout;
          source = "claude_oauth_keychain";
        }
      } catch {}
    }
    raw ??= readPrivate(
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
    const clean = select(oauth, [
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
    return new SubscriptionAuth(source, {
      "/agent-home/.claude/.credentials.json": JSON.stringify({
        claudeAiOauth: clean,
      }),
    });
  }
  if (agent === "kimi") {
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
      endpoint = (provider.base_url ?? "").replace(/\/+$/, "");
    const hosts: Record<string, string> = {
      "https://api.kimi.com/coding/v1": "https://auth.kimi.com",
      "https://api.kimi.ai/coding/v1": "https://auth.kimi.ai",
    };
    if (
      provider.type !== "kimi" ||
      !hosts[endpoint] ||
      oauth.storage !== "file" ||
      !/^oauth\/[A-Za-z0-9_-]+$/.test(key) ||
      (oauth.oauth_host ?? hosts[endpoint]) !== hosts[endpoint]
    )
      throw Error(
        "Kimi requires its managed subscription login; run kimi login",
      );
    const data = object(
      readPrivate(path.join(root, "credentials", key.split("/")[1] + ".json")),
    );
    if (typeof data.access_token !== "string" || !data.access_token)
      throw Error("Kimi subscription token missing; run kimi login");
    const clean = select(data, [
        "access_token",
        "refresh_token",
        "expires_at",
        "scope",
        "token_type",
        "expires_in",
      ]),
      selected =
        config.models?.[model] ?? config.models?.["kimi-code/" + model];
    if (
      selected?.provider !== "managed:kimi-code" ||
      typeof selected.model !== "string" ||
      !Number.isSafeInteger(selected.max_context_size)
    )
      throw Error("select a model from the Kimi subscription aliases");
    const q = JSON.stringify;
    const pub = `default_model = ${q(model)}\ntelemetry = false\n[providers."managed:kimi-code"]\ntype = "kimi"\nbase_url = ${q(endpoint)}\n[providers."managed:kimi-code".oauth]\nstorage = "file"\nkey = ${q(key)}\noauth_host = ${q(hosts[endpoint])}\n[models.${q(model)}]\nprovider = "managed:kimi-code"\nmodel = ${q(selected.model)}\nmax_context_size = ${selected.max_context_size}\ncapabilities = ["image_in", "thinking", "tool_use"]\n`;
    return new SubscriptionAuth(
      "kimi_managed_oauth",
      {
        ["/agent-home/.kimi-code/credentials/" + key.split("/")[1] + ".json"]:
          JSON.stringify(clean),
      },
      {},
      {
        "/agent-home/.kimi-code/config.toml": pub,
        "/agent-home/empty-skills/.keep": "",
      },
    );
  }
  throw Error("subscription authentication is not implemented for " + agent);
}

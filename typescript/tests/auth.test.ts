// Ported from the retired Python tests/test_agent_auth.py. Synthetic
// credentials only; a fake `docker` CLI stands in for worker containers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseTOML } from "@iarna/toml";
import { writeJSON } from "../src/support.ts";
import { temporary, which } from "../src/process.ts";
import { authMode, loadSubscription, SubscriptionAuth } from "../src/auth.ts";
import { command, CLEAN_EXEC, DockerRunner } from "../src/runner.ts";
import { captureResult } from "../src/agent_bench.ts";
import { taskMetrics } from "../src/report.ts";
import { script, withEnv, withFakeDocker, withPath } from "./helpers.ts";

const CODEX_FILE = "/agent-home/.codex/auth.json";

test("requested agents default to subscription; API requires an explicit choice", () => {
  for (const name of ["codex", "claude", "kimi"]) {
    assert.equal(authMode(name), "subscription");
    assert.equal(authMode(name, "api"), "api");
  }
  assert.equal(authMode("opencode"), "api");
  assert.throws(() => authMode("pi", "subscription"));
});

test("subscription commands preserve OAuth and pin the Codex ChatGPT login", () => {
  let argv = command({
    agent: "claude",
    model: "model",
    prompt: "prompt",
    mode: "subscription",
  });
  assert.ok(!argv.includes("--bare"));
  assert.ok(argv.includes("--safe-mode"));
  assert.equal(argv[argv.indexOf("--setting-sources") + 1], "");
  assert.ok(
    command({
      agent: "claude",
      model: "model",
      prompt: "p",
      mode: "api",
    }).includes("--bare"),
  );
  argv = command({
    agent: "codex",
    model: "model",
    prompt: "prompt",
    mode: "subscription",
  });
  assert.ok(argv.includes('forced_login_method="chatgpt"'));
  assert.ok(argv.includes('cli_auth_credentials_store="file"'));
});

test("Codex imports only the ChatGPT cache and rejects an API key", () =>
  temporary("tikz-codex-auth-", async (dir) => {
    const p = path.join(dir, "auth.json");
    writeJSON(p, {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
        account_id: "synthetic-account",
        unrelated: "private",
      },
      unrelated: "private",
    });
    const auth = await loadSubscription("codex", "model", p),
      value = JSON.parse(auth.files[CODEX_FILE]);
    assert.deepEqual(Object.keys(value).sort(), [
      "OPENAI_API_KEY",
      "auth_mode",
      "tokens",
    ]);
    assert.equal(value.tokens.unrelated, undefined);
    assert.deepEqual(auth.publicFiles, {});
    writeJSON(p, { auth_mode: "apikey", OPENAI_API_KEY: "synthetic-paid-key" });
    await assert.rejects(
      loadSubscription("codex", "model", p),
      /ChatGPT login/,
    );
  }));

test("Claude uses an explicit subscription token or only OAuth file fields", () =>
  temporary("tikz-claude-auth-", async (dir) => {
    const token = "sk-ant-oat01-synthetic-subscription";
    const auth = await withEnv(
      {
        CLAUDE_CODE_OAUTH_TOKEN: token,
        ANTHROPIC_API_KEY: "synthetic-paid-key",
      },
      () => loadSubscription("claude", "model"),
    );
    assert.deepEqual(auth.env, { CLAUDE_CODE_OAUTH_TOKEN: token });
    const p = path.join(dir, "claude.json");
    writeJSON(p, {
      claudeAiOauth: {
        accessToken: "synthetic-access",
        refreshToken: "synthetic-refresh",
        expiresAt: 0,
        subscriptionType: "max",
        unrelated: "private",
      },
      apiKey: "synthetic-paid-key",
    });
    const file = await loadSubscription("claude", "model", p);
    assert.deepEqual(file.env, {});
    const raw = file.files["/agent-home/.claude/.credentials.json"];
    assert.ok(!raw.includes("synthetic-paid-key"));
    assert.ok(!raw.includes("unrelated"));
    assert.ok(raw.includes("refreshToken")); // the CLI can refresh expired tokens
  }));

test(
  "the Claude keychain fallback never returns unrelated secrets",
  { skip: process.platform !== "darwin" && "macOS Keychain only" },
  () =>
    temporary("tikz-keychain-", async (dir) => {
      // A fake `security` CLI returns the Keychain entry.
      script(
        dir,
        "security",
        "#!/bin/sh\necho '" +
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "synthetic-access",
              refreshToken: "synthetic-refresh",
            },
            apiKey: "synthetic-paid-key",
          }) +
          "'\n",
      );
      const auth = await withEnv({ CLAUDE_CODE_OAUTH_TOKEN: undefined }, () =>
        withPath(dir, () => loadSubscription("claude", "model")),
      );
      assert.equal(auth.source, "claude_oauth_keychain");
      assert.ok(!JSON.stringify(auth.files).includes("synthetic-paid-key"));
    }),
);

function kimiConfig(
  dir: string,
  endpoint = "https://api.kimi.ai/coding/v1",
  key = "oauth/login-fixture",
) {
  fs.mkdirSync(path.join(dir, "credentials"), { recursive: true });
  writeJSON(path.join(dir, "credentials/login-fixture.json"), {
    access_token: "synthetic-kimi-access",
    refresh_token: "synthetic-kimi-refresh",
    expires_at: 9999999999,
    unrelated: "private",
  });
  const q = JSON.stringify;
  fs.writeFileSync(
    path.join(dir, "config.toml"),
    `default_model = "another-model"
[providers."managed:kimi-code"]
type = "kimi"
base_url = ${q(endpoint)}
api_key = ""
[providers."managed:kimi-code".oauth]
storage = "file"
key = ${q(key)}
oauth_host = "https://auth.kimi.ai"
[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144
[hooks]
command = "must not be imported"
`,
  );
}

test("Kimi uses managed OAuth with the matching region and selected model", () =>
  temporary("tikz-kimi-region-", async (dir) => {
    kimiConfig(dir);
    const auth = await loadSubscription(
        "kimi",
        "kimi-code/kimi-for-coding",
        dir,
      ),
      doc = parseTOML(
        auth.publicFiles["/agent-home/.kimi-code/config.toml"],
      ) as any,
      provider = doc.providers["managed:kimi-code"];
    assert.equal(provider.base_url, "https://api.kimi.ai/coding/v1");
    assert.equal(provider.oauth.key, "oauth/login-fixture");
    assert.deepEqual(Object.keys(provider).sort(), [
      "base_url",
      "oauth",
      "type",
    ]);
    assert.equal(doc.hooks, undefined);
    assert.equal(doc.default_model, "kimi-code/kimi-for-coding");
    assert.deepEqual(Object.keys(doc.models), ["kimi-code/kimi-for-coding"]);
    assert.ok(
      !JSON.stringify(auth.publicFiles).includes("synthetic-kimi-access"),
    );
    assert.ok(
      "/agent-home/.kimi-code/credentials/login-fixture.json" in auth.files,
    );
    assert.ok(!JSON.stringify(auth.files).includes("unrelated"));
  }));

test("Kimi rejects external routes and traversal in the OAuth reference", () =>
  temporary("tikz-kimi-reject-", async (dir) => {
    for (const [endpoint, key] of [
      ["https://untrusted.example/v1", "oauth/login-fixture"],
      ["https://api.kimi.ai/coding/v1", "oauth/../../private"],
    ]) {
      kimiConfig(dir, endpoint, key);
      await assert.rejects(
        loadSubscription("kimi", "kimi-code/kimi-for-coding", dir),
        /managed subscription/,
      );
    }
  }));

test("missing, invalid or symlinked credentials never fall back to an API", () =>
  temporary("tikz-bad-auth-", async (dir) => {
    const p = path.join(dir, "auth.json");
    await withEnv({ CODEX_API_KEY: "synthetic-paid-key" }, () =>
      assert.rejects(loadSubscription("codex", "model", p)),
    );
    fs.writeFileSync(p, '{"access_token":"synthetic-secret-malformed');
    await assert.rejects(loadSubscription("codex", "model", p), (e: Error) => {
      assert.ok(!e.message.includes("synthetic-secret"));
      return true;
    });
    fs.symlinkSync(p, path.join(dir, "link"));
    await assert.rejects(
      loadSubscription("codex", "model", path.join(dir, "link")),
    );
  }));

test("the clean worker environment removes ambient API keys and billing overrides", () => {
  const node = which("node"),
    r = spawnSync(
      node,
      [
        "-e",
        CLEAN_EXEC,
        '["CLAUDE_CODE_OAUTH_TOKEN"]',
        node,
        "-e",
        "console.log(JSON.stringify(process.env))",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "synthetic-paid-key",
          CODEX_API_KEY: "synthetic-paid-key",
          KIMI_API_KEY: "synthetic-paid-key",
          ANTHROPIC_BASE_URL: "https://untrusted.example",
          CLAUDE_CODE_SIMPLE: "1",
          CLAUDE_CODE_OAUTH_TOKEN: "synthetic-oauth",
        },
      },
    );
  assert.equal(r.status, 0, r.stderr);
  const cleaned = JSON.parse(r.stdout);
  assert.equal(cleaned.CLAUDE_CODE_OAUTH_TOKEN, "synthetic-oauth");
  for (const key of [
    "ANTHROPIC_API_KEY",
    "CODEX_API_KEY",
    "KIMI_API_KEY",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_SIMPLE",
  ])
    assert.equal(cleaned[key], undefined, key);
});

test("worker credentials travel over stdin and are redacted from all artifacts", () =>
  temporary("tikz-redact-", async (dir) => {
    const secret = "synthetic-subscription-secret",
      auth = new SubscriptionAuth("test", {
        [CODEX_FILE]: JSON.stringify({ tokens: { access_token: secret } }),
      }),
      runner = new DockerRunner({
        image: "image",
        agent: "codex",
        model: "m",
        mode: "subscription",
        subscription: auth,
      });
    runner.identity = { image_id: "image" };
    await withFakeDocker(
      {
        agent: { stdout: secret, stderr: secret },
        snapshot: { stdout: JSON.stringify({ submission: secret }) },
      },
      async (calls) => {
        const r = await runner.run(dir, ["codex", "exec", "prompt"], 10);
        const log = calls();
        assert.ok(
          log.some((c) => c.args.includes("-i") && c.stdin.includes(secret)),
        );
        assert.ok(!log.some((c) => c.args.join(" ").includes(secret)));
        assert.deepEqual(
          [r.stdout, r.stderr, r.submission],
          ["[REDACTED]", "[REDACTED]", "[REDACTED]"],
        );
      },
    );
  }));

test("subscription mode rejects API credentials even when present", () =>
  withEnv({ ANTHROPIC_API_KEY: "synthetic-paid-key" }, () => {
    assert.throws(
      () =>
        new DockerRunner({
          image: "image",
          agent: "claude",
          model: "m",
          keys: ["ANTHROPIC_API_KEY"],
          mode: "subscription",
          subscription: new SubscriptionAuth("test"),
        }),
      /cannot pass API/,
    );
  }));

test("refreshed credentials are reused only in memory and reject account changes", () =>
  temporary("tikz-refresh-", async (dir) => {
    const p = path.join(dir, "auth.json");
    writeJSON(p, {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      last_refresh: "2000-01-01T00:00:00Z",
      tokens: {
        access_token: "old-access",
        refresh_token: "old-refresh",
        account_id: "original",
      },
    });
    const auth = await loadSubscription("codex", "model", p),
      refreshed = JSON.parse(auth.files[CODEX_FILE]);
    Object.assign(refreshed.tokens, {
      access_token: "new-access",
      refresh_token: "new-refresh",
    });
    refreshed.last_refresh = "2026-09-27T00:00:00Z";
    refreshed.untrusted_setting = "never imported";
    auth.acceptRefresh({ [CODEX_FILE]: JSON.stringify(refreshed) });
    const saved = JSON.parse(auth.files[CODEX_FILE]);
    assert.equal(saved.tokens.access_token, "new-access");
    assert.equal(saved.last_refresh, refreshed.last_refresh);
    assert.equal(
      JSON.parse(fs.readFileSync(p, "utf8")).tokens.access_token,
      "old-access",
    );
    assert.ok(!auth.files[CODEX_FILE].includes("untrusted_setting"));
    assert.ok(auth.secrets.includes("new-access"));
    refreshed.tokens.account_id = "another-account";
    assert.throws(
      () => auth.acceptRefresh({ [CODEX_FILE]: JSON.stringify(refreshed) }),
      /changed subscription account/,
    );
    assert.throws(() => auth.acceptRefresh({}), /did not return/);
  }));

test("failed credential capture keeps the answer and blocks later tasks", () =>
  temporary("tikz-capture-", async (dir) => {
    const auth = new SubscriptionAuth("test", {
        [CODEX_FILE]: JSON.stringify({
          auth_mode: "chatgpt",
          tokens: { access_token: "synthetic-access" },
        }),
      }),
      runner = new DockerRunner({
        image: "image",
        agent: "codex",
        model: "m",
        mode: "subscription",
        subscription: auth,
      });
    runner.identity = { image_id: "image" };
    await withFakeDocker(
      {
        agent: { stdout: "paid reply" },
        snapshot: {
          stdout: '{"submission":"edited notes","credentials":{}}',
        },
      },
      async (calls) => {
        const r = await runner.run(dir, ["codex", "exec", "prompt"], 10);
        assert.equal(r.submission, "edited notes");
        assert.equal(r.stdout, "paid reply");
        const before = calls().length;
        await assert.rejects(
          runner.run(dir, ["codex", "exec", "prompt"], 10),
          /subscription credential capture failed/,
        );
        assert.equal(calls().length, before);
      },
    );
  }));

test("reports identify subscription estimates without claiming zero cost", () =>
  temporary("tikz-estimate-", async (dir) => {
    const record = {
      agent: {
        name: "claude",
        billing_mode: "subscription",
        auth_source: "test",
      },
    };
    const result = captureResult(
      record,
      path.join(dir, "answer"),
      { returncode: 0 },
      {
        completed: true,
        wall_seconds: 5,
        cost_usd: 0.1,
        cost_source: "cli_estimate",
        usage: {},
      },
    );
    const row = taskMetrics(result);
    assert.equal(row.billing_mode, "subscription");
    assert.equal(row.auth_source, "test");
    assert.equal(row.cost_usd, 0.1);
    assert.equal(row.cost_source, "subscription_api_equivalent_estimate");
  }));

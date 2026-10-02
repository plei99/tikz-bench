"""Subscription routing tests use synthetic credentials, never real accounts."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import agent_auth
import agent_bench
import agent_runner
import bench


class SubscriptionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def write(self, name, value):
        p = self.root / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(value))
        return p

    def test_requested_agents_default_to_subscription_and_api_requires_explicit_choice(self):
        for name in ("codex", "claude", "kimi"):
            self.assertEqual(agent_auth.auth_mode(name), "subscription")
            self.assertEqual(agent_auth.auth_mode(name, "api"), "api")
        self.assertEqual(agent_auth.auth_mode("opencode"), "api")
        with self.assertRaises(ValueError):
            agent_auth.auth_mode("pi", "subscription")

    def test_subscription_commands_preserve_oauth_and_pin_codex_chatgpt_login(self):
        argv = agent_runner.command("claude", "model", "prompt", auth_mode="subscription")
        self.assertNotIn("--bare", argv)
        self.assertIn("--safe-mode", argv)
        self.assertEqual(argv[argv.index("--setting-sources") + 1], "")
        self.assertIn("--bare", agent_runner.command("claude", "model", "prompt", auth_mode="api"))
        argv = agent_runner.command("codex", "model", "prompt", auth_mode="subscription")
        self.assertIn('forced_login_method="chatgpt"', argv)
        self.assertIn('cli_auth_credentials_store="file"', argv)

    def test_codex_imports_only_chatgpt_cache_and_rejects_api_key(self):
        p = self.write("auth.json", {"auth_mode": "chatgpt", "OPENAI_API_KEY": None,
                                   "tokens": {"access_token": "synthetic-access", "refresh_token": "synthetic-refresh",
                                              "account_id": "synthetic-account", "unrelated": "private"},
                                   "unrelated": "private"})
        auth = agent_auth.load_subscription("codex", "model", p)
        value = json.loads(auth.files["/agent-home/.codex/auth.json"])
        self.assertEqual(set(value), {"auth_mode", "OPENAI_API_KEY", "tokens"})
        self.assertNotIn("unrelated", value["tokens"])
        self.assertNotIn("synthetic-access", repr(auth))
        self.assertEqual(auth.public_files, {})
        self.write("auth.json", {"auth_mode": "apikey", "OPENAI_API_KEY": "synthetic-paid-key"})
        with self.assertRaisesRegex(ValueError, "ChatGPT login"):
            agent_auth.load_subscription("codex", "model", p)

    def test_claude_uses_explicit_subscription_token_or_only_oauth_file_fields(self):
        token = "sk-ant-oat01-synthetic-subscription"
        with patch.dict(os.environ, {"CLAUDE_CODE_OAUTH_TOKEN": token, "ANTHROPIC_API_KEY": "synthetic-paid-key"}):
            auth = agent_auth.load_subscription("claude", "model")
        self.assertEqual(auth.env, {"CLAUDE_CODE_OAUTH_TOKEN": token})
        p = self.write("claude.json", {"claudeAiOauth": {
            "accessToken": "synthetic-access", "refreshToken": "synthetic-refresh", "expiresAt": 0,
            "subscriptionType": "max", "unrelated": "private"}, "apiKey": "synthetic-paid-key"})
        auth = agent_auth.load_subscription("claude", "model", p)
        self.assertEqual(auth.env, {})
        raw = auth.files["/agent-home/.claude/.credentials.json"]
        self.assertNotIn("synthetic-paid-key", raw)
        self.assertNotIn("unrelated", raw)
        self.assertIn("refreshToken", raw)  # The CLI can refresh expired access tokens.

    def test_claude_keychain_fallback_never_returns_unrelated_secrets(self):
        result = subprocess.CompletedProcess([], 0, json.dumps({
            "claudeAiOauth": {"accessToken": "synthetic-access", "refreshToken": "synthetic-refresh"},
            "apiKey": "synthetic-paid-key"}), "")
        with patch.dict(os.environ, {}, clear=True), patch.object(agent_auth.sys, "platform", "darwin"), \
                patch.object(agent_auth.subprocess, "run", return_value=result):
            auth = agent_auth.load_subscription("claude", "model")
        self.assertEqual(auth.source, "claude_oauth_keychain")
        self.assertNotIn("synthetic-paid-key", str(auth.files))

    def kimi_config(self, endpoint="https://api.kimi.ai/coding/v1", key="oauth/login-fixture"):
        self.write("credentials/login-fixture.json", {"access_token": "synthetic-kimi-access",
                   "refresh_token": "synthetic-kimi-refresh", "expires_at": 9999999999,
                   "unrelated": "private"})
        (self.root / "config.toml").write_text(
            'default_model = "another-model"\n[providers."managed:kimi-code"]\ntype = "kimi"\n'
            f'base_url = {json.dumps(endpoint)}\napi_key = ""\n'
            f'[providers."managed:kimi-code".oauth]\nstorage = "file"\nkey = {json.dumps(key)}\n'
            'oauth_host = "https://auth.kimi.ai"\n'
            '[models."kimi-code/kimi-for-coding"]\nprovider = "managed:kimi-code"\n'
            'model = "kimi-for-coding"\nmax_context_size = 262144\n'
            '[hooks]\ncommand = "must not be imported"\n')

    def test_kimi_uses_managed_oauth_with_matching_region_and_selected_model(self):
        self.kimi_config()
        auth = agent_auth.load_subscription("kimi", "kimi-code/kimi-for-coding", self.root)
        doc = tomllib.loads(auth.public_files["/agent-home/.kimi-code/config.toml"])
        provider = doc["providers"]["managed:kimi-code"]
        self.assertEqual(provider["base_url"], "https://api.kimi.ai/coding/v1")
        self.assertEqual(provider["oauth"]["key"], "oauth/login-fixture")
        self.assertEqual(set(provider), {"type", "base_url", "oauth"})
        self.assertNotIn("hooks", doc)
        self.assertEqual(doc["default_model"], "kimi-code/kimi-for-coding")
        self.assertEqual(set(doc["models"]), {"kimi-code/kimi-for-coding"})
        self.assertNotIn("synthetic-kimi-access", str(auth.public_files))
        self.assertIn("/agent-home/.kimi-code/credentials/login-fixture.json", auth.files)
        self.assertNotIn("unrelated", str(auth.files))

    def test_kimi_rejects_external_routes_and_path_traversal_in_oauth_reference(self):
        for endpoint, key in (("https://untrusted.example/v1", "oauth/login-fixture"),
                              ("https://api.kimi.ai/coding/v1", "oauth/../../private")):
            self.kimi_config(endpoint, key)
            with self.assertRaisesRegex(ValueError, "managed subscription"):
                agent_auth.load_subscription("kimi", "kimi-code/kimi-for-coding", self.root)

    def test_missing_invalid_or_symlink_credentials_never_fall_back_to_api(self):
        p = self.root / "auth.json"
        with patch.dict(os.environ, {"CODEX_API_KEY": "synthetic-paid-key"}):
            with self.assertRaises(ValueError):
                agent_auth.load_subscription("codex", "model", p)
        p.write_text('{"access_token":"synthetic-secret-malformed')
        with self.assertRaises(ValueError) as error:
            agent_auth.load_subscription("codex", "model", p)
        self.assertNotIn("synthetic-secret", str(error.exception))
        (self.root / "link").symlink_to(p)
        with self.assertRaises(ValueError):
            agent_auth.load_subscription("codex", "model", self.root / "link")

    def test_clean_worker_environment_removes_ambient_api_keys_and_billing_overrides(self):
        env = dict(os.environ, ANTHROPIC_API_KEY="synthetic-paid-key", CODEX_API_KEY="synthetic-paid-key",
                   KIMI_API_KEY="synthetic-paid-key", ANTHROPIC_BASE_URL="https://untrusted.example",
                   CLAUDE_CODE_SIMPLE="1", CLAUDE_CODE_OAUTH_TOKEN="synthetic-oauth")
        result = subprocess.run([sys.executable, "-I", "-c", agent_runner.CLEAN_EXEC,
                                 '["CLAUDE_CODE_OAUTH_TOKEN"]', sys.executable, "-c",
                                 'import json,os; print(json.dumps(dict(os.environ)))'],
                                env=env, capture_output=True, text=True, check=True)
        cleaned = json.loads(result.stdout)
        self.assertEqual(cleaned["CLAUDE_CODE_OAUTH_TOKEN"], "synthetic-oauth")
        for key in ("ANTHROPIC_API_KEY", "CODEX_API_KEY", "KIMI_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_SIMPLE"):
            self.assertNotIn(key, cleaned)

    def test_worker_credentials_travel_over_stdin_and_are_redacted_from_all_artifacts(self):
        secret = "synthetic-subscription-secret"
        auth = agent_auth.SubscriptionAuth("test", files={"/agent-home/.codex/auth.json":
                                           json.dumps({"tokens": {"access_token": secret}})})
        runner = agent_runner.DockerRunner("image", "codex", [], auth_mode="subscription", subscription=auth)
        runner.identity = {"image_id": "image"}
        reply = {"returncode": 0, "error": None, "stdout": secret, "stderr": secret}
        snapshot = {"returncode": 0, "error": None, "stdout": json.dumps({"submission": secret}), "stderr": ""}
        with patch.object(runner, "docker", return_value="") as docker, \
                patch.object(agent_runner.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as transfer, \
                patch.object(agent_runner, "capture", side_effect=[reply, snapshot]) as capture:
            result = runner.run("/tmp/task", ["codex", "exec", "prompt"], 10)
        self.assertIn(secret, transfer.call_args.kwargs["input"])
        self.assertNotIn(secret, repr(transfer.call_args.args))
        self.assertNotIn(secret, repr(docker.call_args_list))
        self.assertNotIn(secret, repr(capture.call_args_list))
        self.assertEqual([result[k] for k in ("stdout", "stderr", "submission")], ["[REDACTED]"] * 3)

    def test_subscription_mode_rejects_api_credentials_even_when_present(self):
        with self.assertRaisesRegex(ValueError, "cannot pass API"):
            agent_runner.DockerRunner("image", "claude", ["ANTHROPIC_API_KEY"],
                                      auth_mode="subscription", subscription=agent_auth.SubscriptionAuth("test"))

    def test_refreshed_credentials_are_reused_only_in_memory_and_reject_account_changes(self):
        path = self.write("auth.json", {"auth_mode": "chatgpt", "OPENAI_API_KEY": None,
                         "last_refresh": "2000-01-01T00:00:00Z", "tokens": {
                             "access_token": "old-access", "refresh_token": "old-refresh", "account_id": "original"}})
        auth = agent_auth.load_subscription("codex", "model", path)
        remote = "/agent-home/.codex/auth.json"
        refreshed = json.loads(auth.files[remote])
        refreshed["tokens"].update(access_token="new-access", refresh_token="new-refresh")
        refreshed["last_refresh"] = "2026-09-27T00:00:00Z"
        refreshed["untrusted_setting"] = "never imported"
        auth.accept_refresh({remote: json.dumps(refreshed)})
        self.assertEqual(json.loads(auth.files[remote])["tokens"]["access_token"], "new-access")
        self.assertEqual(json.loads(auth.files[remote])["last_refresh"], refreshed["last_refresh"])
        self.assertEqual(json.loads(path.read_text())["tokens"]["access_token"], "old-access")
        self.assertNotIn("untrusted_setting", auth.files[remote])
        self.assertIn("new-access", auth.secrets)
        refreshed["tokens"]["account_id"] = "another-account"
        with self.assertRaisesRegex(ValueError, "changed the subscription account"):
            auth.accept_refresh({remote: json.dumps(refreshed)})
        with self.assertRaisesRegex(ValueError, "did not return"):
            auth.accept_refresh({})

    def test_failed_credential_capture_keeps_answer_and_blocks_later_tasks(self):
        auth = agent_auth.SubscriptionAuth("test", files={"/agent-home/.codex/auth.json": json.dumps({
            "auth_mode": "chatgpt", "tokens": {"access_token": "synthetic-access"}})})
        runner = agent_runner.DockerRunner("image", "codex", [], auth_mode="subscription", subscription=auth)
        runner.identity = {"image_id": "image"}
        reply = {"returncode": 0, "error": None, "stdout": "paid reply", "stderr": ""}
        snapshot = {"returncode": 0, "error": None, "stdout": '{"submission":"edited notes","credentials":{}}', "stderr": ""}
        with patch.object(runner, "docker", return_value=""), patch.object(runner, "install_files"), \
                patch.object(agent_runner, "capture", side_effect=[reply, snapshot]):
            result = runner.run("/tmp/task", ["codex", "exec", "prompt"], 10)
        self.assertEqual(result["submission"], "edited notes")
        self.assertEqual(result["stdout"], "paid reply")
        with patch.object(agent_runner, "capture") as capture:
            with self.assertRaisesRegex(ValueError, "subscription credential capture failed"):
                runner.run("/tmp/task", ["codex", "exec", "prompt"], 10)
            capture.assert_not_called()

    def test_reports_identify_subscription_estimates_without_claiming_zero_cost(self):
        record = {"agent": {"name": "claude", "billing_mode": "subscription", "auth_source": "test"}}
        metrics = {"completed": True, "wall_seconds": 5, "cost_usd": 0.1, "cost_source": "cli_estimate", "usage": {}}
        result = agent_bench.capture_result(record, self.root / "answer", {"returncode": 0}, metrics)
        row = bench.task_metrics(result)
        self.assertEqual(row["billing_mode"], "subscription")
        self.assertEqual(row["auth_source"], "test")
        self.assertEqual(row["cost_usd"], 0.1)
        self.assertEqual(row["cost_source"], "subscription_api_equivalent_estimate")


if __name__ == "__main__":
    unittest.main()

"""Load only subscription credentials, never a user's agent configuration/history.

These objects are intentionally not serializable run metadata. Tokens are passed
to disposable workers through stdin or environment variables, not argv or mounts.
"""

import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tomllib

SUBSCRIPTION_AGENTS = {"codex", "claude", "kimi"}


def auth_mode(agent, requested=None):
    mode = requested or ("subscription" if agent in SUBSCRIPTION_AGENTS else "api")
    if mode not in {"subscription", "api"}:
        raise ValueError("authentication must be subscription or api")
    if mode == "subscription" and agent not in SUBSCRIPTION_AGENTS:
        raise ValueError(f"subscription authentication is not implemented for {agent}")
    return mode


def read_private(path):
    """Bounded regular-file read; error messages must never echo credentials."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > 1024 * 1024:
                raise ValueError()
            value = source.read(1024 * 1024 + 1)
        if len(value) > 1024 * 1024:
            raise ValueError()
        return value.decode("utf-8")
    except (OSError, ValueError):
        raise ValueError("subscription credential file is missing, unreadable or invalid; sign in again") from None


def json_object(raw):
    try:
        value = json.loads(raw)
        if isinstance(value, dict):
            return value
    except (ValueError, TypeError):
        pass
    raise ValueError("invalid subscription credential JSON; sign in again")


class SubscriptionAuth:
    def __init__(self, source, *, files=None, env=None, public_files=None):
        self.source = source
        self.files = files or {}
        self.env = env or {}
        self.public_files = public_files or {}
        self.error = None
        self.secrets = []
        def collect(value, key=""):
            if isinstance(value, dict):
                for k, v in value.items():
                    collect(v, k)
            elif isinstance(value, str) and ("token" in key.lower() or key == "account_id") and value:
                self.secrets.append(value)
        for content in self.files.values():
            collect(json_object(content))
        self.secrets.extend(self.env.values())

    def accept_refresh(self, files):
        """Keep refreshed tokens in memory for the next serial task, never on the host.

        Workers are untrusted: accept only the same credential format/account,
        retain the original non-token fields and never import worker config.
        """
        if not isinstance(files, dict) or set(files) != set(self.files):
            raise ValueError("worker did not return the subscription credential cache")
        updated = {}
        for path, raw in files.items():
            before, after = json_object(self.files[path]), json_object(raw)
            if path.endswith("/.codex/auth.json"):
                if (after.get("auth_mode") != "chatgpt" or after.get("OPENAI_API_KEY")
                        or not isinstance(after.get("tokens"), dict)
                        or after["tokens"].get("account_id") != before["tokens"].get("account_id")):
                    raise ValueError("worker changed the subscription account or authentication method")
                original, refreshed = before["tokens"], after["tokens"]
                fields, required = {"access_token", "refresh_token", "id_token"}, "access_token"
                if isinstance(after.get("last_refresh"), str) and len(after["last_refresh"]) < 100:
                    before["last_refresh"] = after["last_refresh"]
            elif path.endswith("/.claude/.credentials.json"):
                original, refreshed = before["claudeAiOauth"], after.get("claudeAiOauth")
                fields, required = {"accessToken", "refreshToken", "expiresAt", "refreshTokenExpiresAt"}, "accessToken"
            else:
                original, refreshed = before, after
                fields, required = {"access_token", "refresh_token", "expires_at", "expires_in"}, "access_token"
            if not isinstance(refreshed, dict) or not isinstance(refreshed.get(required), str) or not refreshed[required]:
                raise ValueError("invalid refreshed subscription credential cache")
            for key in fields:
                if key not in refreshed:
                    continue
                value = refreshed[key]
                if "token" in key.lower() and not isinstance(value, str):
                    raise ValueError("invalid refreshed subscription token")
                if "expire" in key.lower() and (type(value) not in (int, float) or not math.isfinite(value) or value < 0):
                    raise ValueError("invalid refreshed subscription expiration")
                if "token" in key.lower() and value:
                    self.secrets.append(value)
                original[key] = value
            updated[path] = json.dumps(before)
        self.files = updated


def load_subscription(agent, model, path=None):
    home = Path.home()
    if agent == "codex":
        path = Path(path) if path else Path(os.environ.get("CODEX_HOME", home / ".codex")) / "auth.json"
        data = json_object(read_private(path))
        tokens = data.get("tokens")
        if (data.get("auth_mode") not in (None, "chatgpt") or data.get("OPENAI_API_KEY")
                or not isinstance(tokens, dict) or not tokens.get("access_token")):
            raise ValueError('Codex requires ChatGPT login; run codex -c cli_auth_credentials_store="file" login')
        selected = {k: v for k, v in tokens.items() if k in {"id_token", "access_token", "refresh_token", "account_id"}}
        if any(not isinstance(v, str) for v in selected.values()):
            raise ValueError("invalid Codex ChatGPT credentials")
        clean = {"auth_mode": "chatgpt", "OPENAI_API_KEY": None, "tokens": selected}
        if isinstance(data.get("last_refresh"), str):
            clean["last_refresh"] = data["last_refresh"]
        return SubscriptionAuth("codex_chatgpt_cache", files={"/agent-home/.codex/auth.json": json.dumps(clean)})

    if agent == "claude":
        # setup-token is the documented, portable subscription auth for CI.
        token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") if path is None else None
        if token:
            if not token.startswith("sk-ant-oat"):
                raise ValueError("CLAUDE_CODE_OAUTH_TOKEN must be a subscription token from claude setup-token")
            return SubscriptionAuth("claude_subscription_token", env={"CLAUDE_CODE_OAUTH_TOKEN": token})
        raw, source = None, "claude_oauth_file"
        if path is None and sys.platform == "darwin":
            try:
                result = subprocess.run(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
                                        capture_output=True, text=True, timeout=10)
                if result.returncode == 0:
                    raw, source = result.stdout, "claude_oauth_keychain"
            except (OSError, subprocess.SubprocessError):
                pass
        if raw is None:
            path = Path(path) if path else Path(os.environ.get("CLAUDE_CONFIG_DIR", home / ".claude")) / ".credentials.json"
            raw = read_private(path)
        oauth = json_object(raw).get("claudeAiOauth")
        if not isinstance(oauth, dict) or not oauth.get("accessToken"):
            raise ValueError("Claude subscription login missing; run claude auth login or claude setup-token")
        keys = {"accessToken", "refreshToken", "expiresAt", "refreshTokenExpiresAt", "scopes", "subscriptionType", "rateLimitTier"}
        clean = {k: v for k, v in oauth.items() if k in keys}
        if any(not isinstance(clean[k], str) for k in ("accessToken", "refreshToken") if k in clean):
            raise ValueError("invalid Claude subscription credentials")
        return SubscriptionAuth(source, files={"/agent-home/.claude/.credentials.json": json.dumps({"claudeAiOauth": clean})})

    if agent == "kimi":
        root = Path(path) if path else Path(os.environ.get("KIMI_CODE_HOME", home / ".kimi-code"))
        try:
            config = tomllib.loads(read_private(root / "config.toml"))
        except tomllib.TOMLDecodeError:
            raise ValueError("invalid Kimi login configuration; run kimi login") from None
        provider = config.get("providers", {}).get("managed:kimi-code", {})
        oauth = provider.get("oauth") or {}
        key = oauth.get("key", "")
        endpoint = provider.get("base_url", "").rstrip("/")
        hosts = {"https://api.kimi.com/coding/v1": "https://auth.kimi.com",
                 "https://api.kimi.ai/coding/v1": "https://auth.kimi.ai"}
        if (provider.get("type") != "kimi" or endpoint not in hosts or oauth.get("storage") != "file"
                or not re.fullmatch(r"oauth/[A-Za-z0-9_-]+", key)
                or oauth.get("oauth_host", hosts.get(endpoint)) != hosts.get(endpoint)):
            raise ValueError("Kimi requires its managed subscription login; run kimi login")
        # Kimi Code 2.x maps oauth/<name> to credentials/<name>.json.
        data = json_object(read_private(root / "credentials" / (key.split("/")[1] + ".json")))
        if not isinstance(data.get("access_token"), str) or not data["access_token"]:
            raise ValueError("Kimi subscription token missing; run kimi login")
        clean = {k: v for k, v in data.items() if k in
                 {"access_token", "refresh_token", "expires_at", "scope", "token_type", "expires_in"}}
        models = config.get("models", {})
        selected = models.get(model) or models.get("kimi-code/" + model)
        if not isinstance(selected, dict) or selected.get("provider") != "managed:kimi-code":
            raise ValueError("select a model from the Kimi subscription's kimi-code/ model aliases")
        if not isinstance(selected.get("model"), str) or type(selected.get("max_context_size")) is not int:
            raise ValueError("invalid Kimi subscription model configuration")
        public = (f"default_model = {json.dumps(model)}\ntelemetry = false\n"
                  '[providers."managed:kimi-code"]\ntype = "kimi"\n'
                  f"base_url = {json.dumps(endpoint)}\n"
                  '[providers."managed:kimi-code".oauth]\nstorage = "file"\n'
                  f"key = {json.dumps(key)}\n"
                  f"oauth_host = {json.dumps(hosts[endpoint])}\n"
                  f"[models.{json.dumps(model)}]\nprovider = \"managed:kimi-code\"\n"
                  f"model = {json.dumps(selected['model'])}\nmax_context_size = {selected['max_context_size']}\n"
                  'capabilities = ["image_in", "thinking", "tool_use"]\n')
        # The key is scoped to the service/auth endpoints. Kimi recomputes it
        # at startup, so renaming it would silently select an empty token slot.
        return SubscriptionAuth("kimi_managed_oauth", files={
            f"/agent-home/.kimi-code/credentials/{key.split('/')[1]}.json": json.dumps(clean)},
            public_files={"/agent-home/.kimi-code/config.toml": public, "/agent-home/empty-skills/.keep": ""})
    raise ValueError(f"subscription authentication is not implemented for {agent}")

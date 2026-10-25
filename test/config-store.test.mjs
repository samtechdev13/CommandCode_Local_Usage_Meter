import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  ALLOWED_REFRESH_SECONDS,
  clearApiKey,
  credentialStatus,
  loadAppConfig,
  maskKey,
  saveConfigPatch,
  setApiKey,
  setRefreshSeconds,
  withBaseUrl,
} from "../src/config-store.mjs";

function tempConfig(content) {
  const directory = mkdtempSync(join(tmpdir(), "usage-meter-config-"));
  const configPath = join(directory, "config.json");
  if (content !== undefined) writeFileSync(configPath, content, { mode: 0o600 });
  return { directory, configPath };
}

test("a save preserves comments and unknown keys and writes mode 600", () => {
  const { configPath } = tempConfig(
    JSON.stringify({ $comment: "hand written", custom: { keep: true }, refreshSeconds: 60 }),
  );

  saveConfigPatch(configPath, { refreshSeconds: 30 });

  const written = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(written.$comment, "hand written");
  assert.deepEqual(written.custom, { keep: true });
  assert.equal(written.refreshSeconds, 30);
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
});

test("the key is trimmed, validated and cleared", () => {
  const { configPath } = tempConfig();

  setApiKey(configPath, "  user_abcdefghijklmnop  ");
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).apiKey, "user_abcdefghijklmnop");
  assert.equal(statSync(configPath).mode & 0o777, 0o600);

  assert.throws(() => setApiKey(configPath, "   "), /empty/);
  assert.throws(() => setApiKey(configPath, "two words"), /spaces/);
  assert.throws(() => setApiKey(configPath, "x".repeat(5000)), /too long/);

  clearApiKey(configPath);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).apiKey, "");
});

test("only the offered refresh intervals are accepted", () => {
  const { configPath } = tempConfig();
  assert.equal(setRefreshSeconds(configPath, 30).config.refreshSeconds, 30);
  for (const seconds of ALLOWED_REFRESH_SECONDS) {
    assert.equal(setRefreshSeconds(configPath, seconds).config.refreshSeconds, seconds);
  }
  assert.throws(() => setRefreshSeconds(configPath, 45), /refreshSeconds/);
  assert.throws(() => setRefreshSeconds(configPath, "soon"), /refreshSeconds/);
});

test("masking keeps enough to recognise a key and nothing more", () => {
  assert.equal(maskKey("user_abcdefghijklmnop"), "user_••••mnop");
  assert.equal(maskKey("short"), "••••");
  assert.equal(maskKey(""), "••••");
});

test("credential status never returns the token", () => {
  const status = credentialStatus({ apiKey: "user_abcdefghijklmnop", apiKeyEnv: "CC_TEST_UNSET_KEY" });
  assert.equal(status.configured, true);
  assert.equal(status.source, "config.json");
  assert.equal(status.masked, "user_••••mnop");
  assert.equal("token" in status, false);

  const missing = credentialStatus({
    apiKeyEnv: "CC_TEST_UNSET_KEY",
    creditFiles: [join(tmpdir(), "usage-meter-no-auth.json")],
  });
  assert.equal(missing.configured, false);
  assert.equal(missing.source, "none");
  assert.equal("token" in missing, false);
});

test("loadAppConfig tolerates a missing file and applies a base URL override", () => {
  const { configPath } = tempConfig();
  const loaded = loadAppConfig(configPath);
  assert.equal(loaded.config.refreshSeconds, 120);
  assert.equal(loaded.server.port, 4317);

  const overridden = withBaseUrl(loaded.config, "http://127.0.0.1:8787");
  assert.equal(overridden.endpoints.baseUrl, "http://127.0.0.1:8787");
  assert.equal(loaded.config.endpoints.baseUrl, "https://api.commandcode.ai", "the original is untouched");
});

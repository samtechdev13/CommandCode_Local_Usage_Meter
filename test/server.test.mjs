import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { loadAppConfig } from "../src/config-store.mjs";
import { createAppServer } from "../src/http-server.mjs";
import { Meter } from "../src/state.mjs";
import { FIXTURE_TOKEN, createFixture } from "./fixture-server.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = join(ROOT, "public");

let directory;
let configPath;
let fixture;
let server;
let meter;
let base;
let port;
let token;
const originalEnvKey = process.env.COMMANDCODE_API_KEY;

async function waitForState(predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/api/state`);
    const state = await response.json();
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  throw new Error("timed out waiting for the expected state");
}

async function mutation(path, { method = "POST", body, headers = {} } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-cmeter-token": token, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function rawStatus(pathname, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: pathname, method: "GET", headers }, (response) => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers }));
    });
    request.on("error", reject);
    request.end();
  });
}

before(async () => {
  delete process.env.COMMANDCODE_API_KEY;

  directory = mkdtempSync(join(tmpdir(), "usage-meter-server-"));
  configPath = join(directory, "config.json");

  fixture = createFixture();
  const fixtureUrl = await fixture.listen();

  writeFileSync(
    configPath,
    JSON.stringify({
      refreshSeconds: 30,
      creditFiles: [join(directory, "no-auth.json")],
      endpoints: { baseUrl: fixtureUrl },
    }),
    { mode: 0o600 },
  );

  const loaded = loadAppConfig(configPath);
  meter = new Meter({ config: loaded.config, version: "test" });
  const app = createAppServer({ meter, configPath, publicDir: PUBLIC_DIR, version: "test" });
  server = app.server;
  token = app.token;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      port = server.address().port;
      base = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(() => resolve()));
  }
  if (fixture) await fixture.close();
  if (originalEnvKey === undefined) delete process.env.COMMANDCODE_API_KEY;
  else process.env.COMMANDCODE_API_KEY = originalEnvKey;
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test("a fresh install announces that setup is needed and leaks nothing", async () => {
  const response = await fetch(`${base}/api/state`);
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.configured, false);
  assert.equal(state.needsSetup, true);
  assert.equal(state.result, null);
  assert.equal("token" in state.credential, false);
});

test("static assets are served from the allowlist with hardened headers", async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");

  const html = await response.text();
  assert.match(html, new RegExp(`name="cmeter-token" content="${token}"`));
  assert.equal(html.includes("__CMETER_TOKEN__"), false);

  const miss = await fetch(`${base}/../config.json`);
  assert.equal(miss.status, 404);
  const encoded = await fetch(`${base}/%2e%2e/config.json`);
  assert.equal(encoded.status, 404);
});

test("mutating routes refuse a missing token, a missing content type and a foreign origin", async () => {
  const noToken = await fetch(`${base}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshSeconds: 30 }),
  });
  assert.equal(noToken.status, 403);

  const wrongType = await mutation("/api/settings", { headers: { "content-type": "text/plain" } });
  assert.equal(wrongType.status, 403);

  const foreignOrigin = await mutation("/api/settings", {
    body: { refreshSeconds: 30 },
    headers: { origin: "http://evil.example" },
  });
  assert.equal(foreignOrigin.status, 403);

  const localOrigin = await mutation("/api/settings", {
    body: { refreshSeconds: 30 },
    headers: { origin: `${base}` },
  });
  assert.equal(localOrigin.status, 200);
});

test("the key is stored with mode 600 and returned only masked", async () => {
  const response = await mutation("/api/key", { body: { apiKey: FIXTURE_TOKEN } });
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.configured, true);
  assert.equal(body.credential.source, "config.json");
  assert.equal(body.credential.masked, "test-••••7890");
  assert.equal(JSON.stringify(body).includes(FIXTURE_TOKEN), false);

  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).apiKey, FIXTURE_TOKEN);

  const stateResponse = await fetch(`${base}/api/state`);
  const stateText = await stateResponse.text();
  assert.equal(stateText.includes(FIXTURE_TOKEN), false);
});

test("the dashboard receives live windows, derived monthly, tokens, runs and credits", async () => {
  const state = await waitForState((candidate) => candidate.result?.credits && candidate.result?.fiveHour);
  const { result } = state;

  assert.equal(result.fiveHour.cap, 14);
  assert.equal(result.fiveHour.percent, 0.36);
  assert.equal(result.weekly.percent, 3.34);
  assert.equal(result.monthly.cap, 70);
  assert.equal(result.monthly.percent, 9.16);
  assert.equal(result.credits.used, 6.41);
  assert.equal(result.credits.limit, 70);
  assert.equal(result.credits.remaining, 63.59);
  assert.equal(result.tokens.total, 473000000);
  assert.equal(result.runs.total, 1601);
  assert.equal(result.plan.id, "individual-goat");

  assert.equal(result.display.fiveHourPercent, "0%");
  assert.equal(result.display.fiveHourUsage, "0.05 / 14");
  assert.equal(result.display.tokensValue, "473.0 M");
  assert.equal(result.display.creditsUsed, "6.41");

  assert.equal(state.meta.cost.reported, false);
  assert.equal(state.meta.cost.total, 0);
  assert.ok(state.meta.cost.requests >= 4, "whoami, credits, subscriptions and usage are counted");
});

test("setting an interval outside the offered list is rejected", async () => {
  const invalid = await mutation("/api/settings", { body: { refreshSeconds: 45 } });
  assert.equal(invalid.status, 400);
  assert.deepEqual((await invalid.json()).allowed, [30, 60, 90, 120]);

  const valid = await mutation("/api/settings", { body: { refreshSeconds: 60 } });
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).refreshSeconds, 60);

  const onDisk = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(onDisk.refreshSeconds, 60);
});

test("refresh answers immediately and unknown routes are 404", async () => {
  const response = await mutation("/api/refresh", { body: {} });
  assert.equal(response.status, 202);
  assert.equal(typeof (await response.json()).meta.fetching, "boolean");

  const missing = await fetch(`${base}/api/nope`);
  assert.equal(missing.status, 404);

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).app, "usage-meter-local");
});

test("oversized bodies are refused before parsing", async () => {
  const response = await mutation("/api/settings", { body: { blob: "x".repeat(9000) } });
  assert.equal(response.status, 413);
});

test("a foreign Host header is refused (DNS rebinding)", async () => {
  const rebinding = await rawStatus("/api/state", { host: "evil.example" });
  assert.equal(rebinding.status, 403);

  const local = await rawStatus("/api/state", { host: `127.0.0.1:${port}` });
  assert.equal(local.status, 200);
});

test("forgetting the key clears the stored credential and the cached numbers", async () => {
  const response = await mutation("/api/key", { method: "DELETE" });
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.configured, false);
  assert.equal(state.result, null);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).apiKey, "");
});

test("a rejected key is reported as authentication needed, not as a network error", async () => {
  const saved = await mutation("/api/key", { body: { apiKey: "wrong-key-0000" } });
  assert.equal(saved.status, 200);

  const state = await waitForState((candidate) => candidate.error?.status === "auth_needed");
  assert.equal(state.configured, true);
  assert.equal(state.error.status, "auth_needed");

  const cleared = await mutation("/api/key", { method: "DELETE" });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).configured, false);
});

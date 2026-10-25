import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  STATUS,
  buildDisplay,
  computeCredits,
  computeMonthlyWindow,
  formatAmount,
  formatClock,
  formatPercent,
  formatTokenCount,
  normalizeConfig,
  parseOrgId,
  parsePeriod,
  parseSpend,
  parseWindow,
  redact,
  resolveCredential,
  resolveProfiles,
} from "../src/limits.mjs";

const PERIOD = {
  start: "2026-10-20T00:00:00.000Z",
  end: "2026-11-16T21:57:00.000Z",
  planId: "individual-goat",
};

test("a rolling window rounds to two decimals and rejects unopened pools", () => {
  const window = parseWindow({ used: 0.05, cap: 14, resetAt: "2026-10-25T15:15:00.000Z" });
  assert.equal(window.percent, 0.36);
  assert.equal(window.used, 0.05);
  assert.equal(window.cap, 14);

  assert.equal(parseWindow({ used: 0, cap: 0 }), null, "a zero cap means the window has not opened");
  assert.equal(parseWindow({ used: 1 }), null);
  assert.equal(parseWindow(null), null);
});

test("the monthly window is derived from spend plus remaining pools", () => {
  const credits = { monthlyCredits: 63.59, purchasedCredits: 0, freeCredits: 0 };
  const monthly = computeMonthlyWindow(credits, PERIOD, { cost: 6.41 });
  assert.equal(monthly.cap, 70);
  assert.equal(monthly.used, 6.41);
  assert.equal(monthly.percent, 9.16);
  assert.equal(monthly.resetAt, PERIOD.end);

  assert.equal(computeMonthlyWindow(credits, { start: null }, { cost: 1 }), null);
});

test("the credit pool keeps a period expiry only when no purchased pool exists", () => {
  const withPurchased = computeCredits(
    { monthlyCredits: 63.59, purchasedCredits: 0, freeCredits: 0 },
    PERIOD,
    6.41,
  );
  assert.equal(withPurchased.used, 6.41);
  assert.equal(withPurchased.limit, 70);
  assert.equal(withPurchased.remaining, 63.59);
  assert.equal(withPurchased.percent, 9.16);
  assert.equal(withPurchased.expiresAt, null);

  const withoutPurchased = computeCredits({ monthlyCredits: 63.59, freeCredits: 0 }, PERIOD, 6.41);
  assert.equal(withoutPurchased.expiresAt, PERIOD.end);

  assert.equal(computeCredits({}, PERIOD, 1), null, "no pool fields means nothing to meter");
});

test("subscription, org and spend payloads unwrap their data envelope", () => {
  assert.deepEqual(parsePeriod({ data: { planId: "individual-goat", currentPeriodStart: PERIOD.start, currentPeriodEnd: PERIOD.end } }), {
    start: PERIOD.start,
    end: PERIOD.end,
    planId: "individual-goat",
  });
  assert.equal(parseOrgId({ data: { org: { id: "org_local" } } }), "org_local");
  assert.equal(parseOrgId({ data: { org: {} } }), null);

  const spend = parseSpend({
    data: { totalCost: 6.41, totalTokens: 473000000, totalCount: 1601, failedCount: 11, successRate: 99.3 },
  });
  assert.equal(spend.cost, 6.41);
  assert.equal(spend.totalTokens, 473000000);
  assert.equal(spend.runs, 1601);
  assert.equal(spend.failedRuns, 11);
});

test("display strings are rounded and localized once, in the engine", () => {
  const now = new Date(2026, 0, 1, 12, 0, 0).getTime();
  const resetAt = new Date(2026, 0, 1, 20, 0, 0).toISOString();
  const result = {
    fiveHour: { used: 0.05, cap: 14, percent: 0.36, resetAt },
    weekly: { used: 1.17, cap: 35, percent: 3.34, resetAt },
    monthly: { used: 6.41, cap: 70, percent: 9.16, resetAt: PERIOD.end },
    credits: { used: 6.41, limit: 70, remaining: 63.59, percent: 9.16 },
    tokens: { total: 473000000, input: 380000000, output: 93000000 },
    runs: { total: 1601, failed: 11, successRate: 99.3 },
  };
  const display = buildDisplay(result, now);
  assert.equal(display.fiveHourPercent, "0%");
  assert.equal(display.weeklyPercent, "3%");
  assert.equal(display.monthlyPercent, "9%");
  assert.equal(display.fiveHourUsage, "0.05 / 14");
  assert.equal(display.fiveHourResetAt, "20:00");
  assert.equal(display.tokensValue, "473.0 M");
  assert.equal(display.runsValue, "1601");
  assert.match(display.creditsText, /6\.41 of 70 USD/);
  assert.match(display.tokensDetail, /380\.0 M in \/ 93\.0 M out/);
});

test("formatters stay inside the engine's contract", () => {
  assert.equal(formatPercent(3.342), "3%");
  assert.equal(formatPercent(Number.NaN), "-");
  assert.equal(formatAmount(2.000223421), "2");
  assert.equal(formatAmount("8.45"), "8.45");
  assert.equal(formatTokenCount(473000000), "473.0 M");
  assert.equal(formatTokenCount(1140000000), "1.14 B");
  assert.equal(formatClock(new Date(2026, 0, 1, 9, 39, 52).getTime()), "09:39:52");
});

test("config normalization clamps intervals and thresholds", () => {
  const config = normalizeConfig({ refreshSeconds: 5, requestTimeoutMs: 10, thresholds: { warn: 140, critical: 85 } });
  assert.equal(config.refreshSeconds, 120, "below the 15 s floor falls back to the default");
  assert.equal(config.requestTimeoutMs, 8000);
  assert.equal(config.thresholds.warn, 100);
  assert.equal(config.thresholds.critical, 85);

  assert.equal(normalizeConfig({ refreshSeconds: 30 }).refreshSeconds, 30);
});

test("credentials follow env -> config -> auth files, and a named account stays strict", () => {
  const fs = { readFileSync };
  const env = { COMMANDCODE_API_KEY: "ambient-key" };

  assert.deepEqual(resolveCredential({ apiKey: "config-key" }, { env, fs }).token, "ambient-key");
  assert.deepEqual(resolveCredential({ apiKey: "config-key" }, { env: {}, fs }).token, "config-key");

  const strict = resolveCredential(
    { strictCredential: true, apiKey: "own-key", profileName: "work" },
    { env, fs },
  );
  assert.equal(strict.token, "own-key", "a named account never borrows the ambient key");
  assert.equal(strict.source, "config.json");
});

test("auth files are read, and an expired token is reported rather than renewed", () => {
  const directory = mkdtempSync(join(tmpdir(), "usage-meter-limits-"));
  const authPath = join(directory, "auth.json");
  const fs = { readFileSync };

  writeFileSync(
    authPath,
    JSON.stringify({ "command-code": { access: "cli-token", expires: Date.now() + 3600_000 } }),
  );
  const live = resolveCredential({ creditFiles: [authPath] }, { env: {}, fs });
  assert.equal(live.token, "cli-token");
  assert.equal(live.source, authPath);

  writeFileSync(authPath, JSON.stringify({ "command-code": { access: "old", expires: Date.now() - 1000 } }));
  const expired = resolveCredential({ creditFiles: [authPath] }, { env: {}, fs });
  assert.equal(expired.error, STATUS.AUTH_NEEDED);
  assert.match(expired.message, /expired/i);

  const missing = resolveCredential({ creditFiles: [join(directory, "nope.json")] }, { env: {}, fs });
  assert.equal(missing.error, STATUS.AUTH_NEEDED);
});

test("profiles validate ids and force each account to its own key", () => {
  const profiles = resolveProfiles({
    apiKey: "ambient",
    profiles: [{ id: "work", apiKey: "work-key" }],
  });
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].id, "work");
  assert.equal(profiles[0].config.strictCredential, true);
  assert.equal(profiles[0].config.apiKey, "work-key");

  assert.throws(() => resolveProfiles({ profiles: [{ id: "Bad Id", apiKey: "x" }] }), /invalid id/);
  assert.throws(
    () => resolveProfiles({ profiles: [{ id: "a", apiKey: "x" }, { id: "a", apiKey: "y" }] }),
    /duplicate/,
  );
});

test("secrets are redacted before they can reach a log", () => {
  assert.equal(redact("Authorization: Bearer abcdefghijklmnop"), "Authorization: Bearer <redacted>");
  assert.equal(redact("token cc_1234567890abcdefghij"), "token <redacted-token>");
});

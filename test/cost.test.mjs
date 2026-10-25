import assert from "node:assert/strict";
import { test } from "node:test";

import { createCostTracker, findCost } from "../src/cost.mjs";

function jsonResponse(payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("a header-reported charge and a body-reported charge are both counted", async () => {
  const fetchImpl = async () => jsonResponse({ data: { requestCost: 0.0025 } }, { "x-request-cost": "0.001" });
  const tracker = createCostTracker(fetchImpl);

  const response = await tracker.fetchImpl("http://example.test/credits", {});
  await response.json();

  const stats = tracker.stats();
  assert.equal(stats.requests, 1);
  assert.equal(stats.reported, true);
  assert.equal(stats.total, 0.0035);
  assert.equal(stats.currency, "USD");
});

test("account spend is not mistaken for a per-request charge", async () => {
  const fetchImpl = async () => jsonResponse({ data: { totalCost: 6.41, totalTokens: 473000000 } });
  const tracker = createCostTracker(fetchImpl);

  const response = await tracker.fetchImpl("http://example.test/usage", {});
  await response.json();

  const stats = tracker.stats();
  assert.equal(stats.requests, 1);
  assert.equal(stats.reported, false);
  assert.equal(stats.total, 0);
});

test("no reported cost stays at zero, and failures are still counted", async () => {
  const fetchImpl = async () => jsonResponse({ data: { windowLimits: {} } });
  const tracker = createCostTracker(fetchImpl);
  for (let index = 0; index < 3; index += 1) {
    const response = await tracker.fetchImpl("http://example.test/x", {});
    await response.json();
  }
  assert.deepEqual(tracker.stats(), { requests: 3, total: 0, currency: "USD", reported: false });

  const failing = createCostTracker(async () => {
    throw new Error("network");
  });
  await assert.rejects(() => failing.fetchImpl("http://example.test/x", {}));
  assert.equal(failing.stats().requests, 1);
});

test("a currency header overrides the default and findCost stays conservative", async () => {
  const fetchImpl = async () => jsonResponse({ data: {} }, { "x-cost-currency": "EUR" });
  const tracker = createCostTracker(fetchImpl);
  await tracker.fetchImpl("http://example.test/x", {});
  assert.equal(tracker.stats().currency, "EUR");

  assert.equal(findCost({ data: { requestCost: 0.5 } }), 0.5);
  assert.equal(findCost({ data: { totalCost: 9.99 } }), undefined);
  assert.equal(findCost({ usage: { requestCost: 0.2 } }), undefined, "only known envelopes are searched");
});

/**
 * Local stand-in for the `api.commandcode.ai/alpha/*` surface.
 *
 * Used by the test suite and available by hand:
 *
 *   node test/fixture-server.mjs --port 8787 --grow
 *   node server.mjs --url http://127.0.0.1:8787 --no-open
 *
 * Any token is accepted unless `--fail=401` is given; the tests use
 * `test-key-1234567890`, which is the only key the fixture considers valid.
 */

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export const FIXTURE_TOKEN = "test-key-1234567890";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function createFixture({ token = FIXTURE_TOKEN, failStatus = 0, grow = false, requestCost = null } = {}) {
  const startedAt = Date.now();
  const periodStart = new Date(startedAt - 5 * DAY).toISOString();
  const periodEnd = new Date(startedAt + 22 * DAY + 11 * HOUR).toISOString();
  let calls = 0;
  let growth = 0;

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const key = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    calls += 1;

    if (failStatus || key !== token) {
      response.writeHead(failStatus || 401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    if (grow && url.pathname === "/alpha/billing/credits") growth += 0.42;

    const send = (payload) => {
      const headers = { "content-type": "application/json" };
      if (requestCost !== null) headers["x-request-cost"] = String(requestCost);
      response.writeHead(200, headers);
      response.end(JSON.stringify(payload));
    };

    if (url.pathname === "/alpha/whoami") {
      return send({ data: { org: { id: "org_local" } } });
    }

    if (url.pathname === "/alpha/billing/credits") {
      return send({
        data: {
          credits: { monthlyCredits: 63.59, purchasedCredits: 0, freeCredits: 0 },
          windowLimits: {
            limited: false,
            exceeded: null,
            fiveHour: {
              used: 0.05 + growth,
              cap: 14,
              resetAt: new Date(startedAt + 4 * HOUR + 18 * MINUTE).toISOString(),
            },
            weekly: {
              used: 1.17 + growth,
              cap: 35,
              resetAt: new Date(startedAt + 6 * DAY + 3 * HOUR).toISOString(),
            },
          },
        },
      });
    }

    if (url.pathname === "/alpha/billing/subscriptions") {
      return send({
        data: {
          planId: "individual-goat",
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        },
      });
    }

    if (url.pathname === "/alpha/usage/summary") {
      return send({
        data: {
          totalCost: 6.41,
          totalMonthlyCredits: 6.41,
          totalTokens: 473_000_000,
          totalTokensIn: 380_000_000,
          totalTokensOut: 93_000_000,
          totalCount: 1601,
          completedCount: 1590,
          failedCount: 11,
          successRate: 99.3,
        },
      });
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });

  return {
    server,
    get calls() {
      return calls;
    },
    listen(port = 0) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve(`http://127.0.0.1:${server.address().port}`);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const args = process.argv.slice(2);
  const portArg = args.find((value) => value.startsWith("--port="));
  const failArg = args.find((value) => value.startsWith("--fail="));
  const port = portArg ? Number(portArg.split("=")[1]) : 8787;
  const failStatus = failArg ? Number(failArg.split("=")[1]) : 0;
  const fixture = createFixture({ failStatus, grow: args.includes("--grow") });
  const url = await fixture.listen(port);
  console.log(`fixture: listening on ${url} (token ${FIXTURE_TOKEN})`);
  console.log("fixture: Ctrl+C to stop");
  const stop = () => fixture.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

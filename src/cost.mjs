/**
 * Request-cost accounting.
 *
 * Command Code's `/alpha/*` endpoints return billing metadata, not billable
 * work: reading them should cost nothing. We cannot prove that for an
 * undocumented API, so every response is inspected for a charge — first in
 * response headers, then in the JSON body — and the dashboard displays what the
 * API actually reports. Absence of a report is shown as `$0.00` with the
 * "not charged" explanation, never invented as a fee.
 */

const COST_HEADERS = [
  "x-request-cost",
  "x-credit-cost",
  "x-usage-cost",
  "x-api-cost",
  "x-charge",
  "x-cost",
];

/**
 * Fields that explicitly describe the cost of the call itself. `totalCost` is
 * deliberately absent: that is the account's cycle spend, not a per-request
 * charge, and counting it would report a cost that was never billed.
 */
const COST_FIELDS = [
  "requestCost",
  "request_cost",
  "requestCharge",
  "request_charge",
  "apiCost",
  "api_cost",
  "chargedCredits",
  "creditsCharged",
];

const NESTED_KEYS = ["data", "meta", "billing"];

function positiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

/** Find an explicitly reported request cost anywhere in a response body. */
export function findCost(value, depth = 0) {
  if (depth > 2 || !value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCost(item, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const field of COST_FIELDS) {
    if (field in value) {
      const found = positiveNumber(value[field]);
      if (found !== undefined) return found;
    }
  }
  for (const key of NESTED_KEYS) {
    if (value[key] && typeof value[key] === "object") {
      const found = findCost(value[key], depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function emptyStats() {
  return { requests: 0, total: 0, currency: "USD", reported: false };
}

/**
 * Wrap a fetch implementation so each call is counted and any charge it
 * reports is summed. Body inspection happens by decorating `response.json()`,
 * so the caller still reads the payload exactly once.
 */
export function createCostTracker(fetchImpl = globalThis.fetch) {
  const stats = emptyStats();

  const add = (amount) => {
    const found = positiveNumber(amount);
    if (found === undefined) return;
    stats.total = Math.round((stats.total + found) * 1e6) / 1e6;
    stats.reported = true;
  };

  const wrapped = async (url, init) => {
    stats.requests += 1;
    const response = await fetchImpl(url, init);

    const headers = response?.headers;
    if (headers && typeof headers.get === "function") {
      for (const name of COST_HEADERS) add(headers.get(name));
      const currency = headers.get("x-cost-currency") || headers.get("x-credit-currency");
      if (typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency.trim())) {
        stats.currency = currency.trim().toUpperCase();
      }
    }

    if (response && typeof response.json === "function") {
      const original = response.json.bind(response);
      try {
        response.json = async () => {
          const body = await original();
          add(findCost(body));
          return body;
        };
      } catch {
        // A frozen Response still works; only the body scan is lost.
      }
    }

    return response;
  };

  return {
    fetchImpl: wrapped,
    stats: () => ({ ...stats }),
    reset: () => Object.assign(stats, emptyStats()),
  };
}

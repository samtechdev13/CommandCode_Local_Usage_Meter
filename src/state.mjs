/**
 * Live state for the dashboard: one cached result, one fetch at a time, and
 * partial delivery so the rolling windows appear before the slower USD tail.
 *
 * There is no polling timer here. The browser poll is the clock: each
 * `/api/state` read asks whether the cache is older than the configured
 * interval and, if so, starts a fetch in the background. Closing the page
 * therefore stops all outbound traffic immediately, which is the right
 * behaviour for a local web app.
 */

import {
  STATUS,
  buildDisplay,
  fetchLimits,
  formatAmount,
  normalizeConfig,
  redact,
} from "./limits.mjs";
import { createCostTracker } from "./cost.mjs";
import { credentialStatus } from "./config-store.mjs";

const MAX_BACKOFF_MS = 15 * 60 * 1000;

function emptyCost() {
  return { requests: 0, total: 0, currency: "USD", reported: false };
}

/** `buildDisplay` plus the few extra strings the dashboard lays out itself. */
export function decorateDisplay(result, now = Date.now()) {
  const display = buildDisplay(result, now);
  if (result.credits) {
    display.creditsUsed = formatAmount(result.credits.used);
    display.creditsLimit = formatAmount(result.credits.limit);
    display.creditsRemaining = formatAmount(result.credits.remaining);
  }
  return display;
}

export class Meter {
  constructor({ config, version = "unknown", fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.config = normalizeConfig(config ?? {});
    this.version = version;
    this.fetchImpl = fetchImpl;
    this.now = now;

    this.result = null;
    this.error = null;
    this.fetchedAt = 0;
    this.partialAt = 0;
    this.lastAttemptAt = 0;
    this.lastDurationMs = 0;
    this.failures = 0;
    this.fetching = false;
    this.revision = 0;
    this.refreshCost = emptyCost();
    this.sessionCost = emptyCost();
  }

  setConfig(config) {
    this.config = normalizeConfig(config ?? {});
  }

  /** Forget the current account's numbers, e.g. after the key is removed. */
  reset() {
    this.result = null;
    this.error = null;
    this.fetchedAt = 0;
    this.partialAt = 0;
    this.lastAttemptAt = 0;
    this.lastDurationMs = 0;
    this.failures = 0;
    this.refreshCost = emptyCost();
    this.sessionCost = emptyCost();
    this.revision += 1;
  }

  /**
   * Everything the dashboard renders. The display block is rebuilt on every
   * read so "reset in 3h 12m" counts down between fetches.
   */
  snapshot({ autoRefresh = false } = {}) {
    if (autoRefresh) this.maybeRefresh();

    const credential = credentialStatus(this.config);
    const result = this.result
      ? { ...this.result, display: decorateDisplay(this.result, this.now()) }
      : null;
    const age = result?.fetchedAt ? this.now() - result.fetchedAt : null;

    return {
      version: this.version,
      configured: credential.configured,
      credential,
      needsSetup: !credential.configured,
      thresholds: this.config.thresholds,
      refreshSeconds: this.config.refreshSeconds,
      result,
      error: this.error,
      stale: Boolean(this.error && result),
      meta: {
        fetching: this.fetching,
        age,
        lastDurationMs: this.lastDurationMs,
        revision: this.revision,
        failures: this.failures,
        requests: this.refreshCost.requests,
        cost: this.refreshCost,
        sessionCost: this.sessionCost,
        fetchedAt: result?.fetchedAt ?? 0,
        partialAt: this.partialAt,
        serverTime: this.now(),
      },
    };
  }

  /** Start a fetch when the cache is older than the configured interval. */
  maybeRefresh() {
    if (this.fetching) return false;
    const interval = Math.max(15, Number(this.config.refreshSeconds) || 120) * 1000;
    const delay =
      this.failures === 0
        ? interval
        : Math.min(MAX_BACKOFF_MS, interval * 2 ** Math.min(this.failures, 5));
    const since = Math.max(this.lastAttemptAt, this.fetchedAt);
    if (this.now() - since < delay) return false;
    void this.refresh("auto");
    return true;
  }

  async refresh(reason = "manual") {
    if (this.fetching) return null;
    this.fetching = true;
    this.lastAttemptAt = this.now();
    this.revision += 1;
    const started = this.now();
    const tracker = createCostTracker(this.fetchImpl);

    try {
      const result = await fetchLimits(this.config, {
        fetchImpl: tracker.fetchImpl,
        onPartial: (partial) => this.publishPartial(partial),
      });
      if (result.status) {
        this.failures += 1;
        this.error = {
          status: result.status,
          message: result.message ?? "",
          httpStatus: result.httpStatus,
          at: this.now(),
        };
      } else {
        this.failures = 0;
        this.error = null;
        this.result = result;
        this.fetchedAt = result.fetchedAt ?? this.now();
      }
      return result;
    } catch (error) {
      this.failures += 1;
      this.error = {
        status: STATUS.NETWORK_ERROR,
        message: redact(`Unexpected error: ${error?.message ?? error}`),
        at: this.now(),
      };
      return null;
    } finally {
      this.refreshCost = tracker.stats();
      this.sessionCost = {
        requests: this.sessionCost.requests + this.refreshCost.requests,
        total: Math.round((this.sessionCost.total + this.refreshCost.total) * 1e6) / 1e6,
        currency: this.refreshCost.currency,
        reported: this.sessionCost.reported || this.refreshCost.reported,
      };
      this.fetching = false;
      this.lastDurationMs = this.now() - started;
      this.revision += 1;
    }
  }

  /**
   * A partial carries the rolling windows only. The previous USD/token/run
   * values stay visible rather than blanking out for the 2.5 s tail.
   */
  publishPartial(partial) {
    if (!partial || partial.status) return;
    const previous = this.result;
    this.result = {
      ...partial,
      credits: previous?.credits ?? null,
      creditsPending: partial.creditsPending === true,
      monthly: previous?.monthly ?? null,
      tokens: previous?.tokens ?? null,
      runs: previous?.runs ?? null,
      plan: previous?.plan ?? null,
      display: {
        ...partial.display,
        ...(previous?.display?.creditsText ? { creditsText: previous.display.creditsText } : {}),
      },
    };
    this.fetchedAt = partial.fetchedAt ?? this.now();
    this.partialAt = this.now();
    this.error = null;
    this.revision += 1;
  }
}

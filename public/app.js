/**
 * Dashboard client.
 *
 * Renders only with textContent: API payloads never reach innerHTML. The API
 * key is posted once and then forgotten — the server answers with a masked form,
 * which is the only credential material this file ever sees.
 */

const POLL_MS = 2000;
const TOKEN = document.querySelector('meta[name="cmeter-token"]').content;

const el = {
  plan: document.getElementById("plan-id"),
  status: document.getElementById("status-pill"),
  updated: document.getElementById("updated"),
  refresh: document.getElementById("refresh-now"),
  settings: document.getElementById("open-settings"),
  banner: document.getElementById("banner"),
  bannerText: document.getElementById("banner-text"),
  bannerAction: document.getElementById("banner-action"),
  auth: document.getElementById("auth"),
  currentKey: document.getElementById("current-key"),
  form: document.getElementById("key-form"),
  input: document.getElementById("api-key"),
  toggle: document.getElementById("toggle-key"),
  save: document.getElementById("save-key"),
  cancel: document.getElementById("auth-cancel"),
  forget: document.getElementById("forget-key"),
  authMessage: document.getElementById("auth-message"),
  dashboard: document.getElementById("dashboard"),
  empty: document.getElementById("empty"),
  emptyTitle: document.getElementById("empty-title"),
  emptyText: document.getElementById("empty-text"),
  emptyRetry: document.getElementById("empty-retry"),
  intervalGroup: document.getElementById("interval-group"),
  tokensValue: document.getElementById("tokens-value"),
  tokensDetail: document.getElementById("tokens-detail"),
  runsValue: document.getElementById("runs-value"),
  runsDetail: document.getElementById("runs-detail"),
  creditsValue: document.getElementById("credits-value"),
  creditsDetail: document.getElementById("credits-detail"),
  creditsBar: document.getElementById("credits-bar"),
  creditsFill: document.getElementById("credits-fill"),
  costValue: document.getElementById("cost-value"),
  costChip: document.getElementById("cost-chip"),
  costRequests: document.getElementById("cost-requests"),
  costCharged: document.getElementById("cost-charged"),
  costSession: document.getElementById("cost-session"),
  costNote: document.getElementById("cost-note"),
  windows: {
    fiveHour: document.getElementById("window-fiveHour"),
    weekly: document.getElementById("window-weekly"),
    monthly: document.getElementById("window-monthly"),
  },
};

const ui = {
  data: null,
  forceAuth: false,
  busy: false,
  pollTimer: null,
  revision: -1,
};

const REFRESH_ERRORS = {
  invalid_refresh_seconds: "That refresh interval is not supported.",
  missing_api_key: "Enter a Provider-API key first.",
  invalid_key: "That key format is not valid.",
  empty_key: "Enter a Provider-API key first.",
  long_key: "That key is too long.",
  forbidden_token: "This page is out of date because the server restarted. Reload it.",
  forbidden_origin: "This page is not allowed to change settings.",
  forbidden_site: "This page is not allowed to change settings.",
  body_too_large: "The request was too large.",
  invalid_json: "The request could not be read.",
};

function friendlyError(error) {
  const code = String(error?.message ?? "");
  return REFRESH_ERRORS[code] ?? code ?? "Something went wrong.";
}

async function request(path, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    headers["X-Cmeter-Token"] = TOKEN;
  }
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "omit",
    cache: "no-store",
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const reason = payload?.message || payload?.error || `Request failed (${response.status})`;
    throw new Error(reason);
  }
  return payload;
}

function clampPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

function toneFor(percent, thresholds) {
  const critical = thresholds?.critical ?? 85;
  const warn = thresholds?.warn ?? 60;
  if (!Number.isFinite(percent)) return "muted";
  if (percent >= critical) return "critical";
  if (percent >= warn) return "warn";
  return "ok";
}

function formatCost(amount, currency = "USD") {
  const numeric = Number(amount);
  const value = Number.isFinite(numeric) ? numeric : 0;
  if (value === 0) return "$0.00";
  const decimals = value < 0.01 ? 6 : 2;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: String(currency || "USD").toUpperCase(),
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(value);
  } catch {
    return `$${value.toFixed(decimals)}`;
  }
}

function formatClock(ms) {
  const date = new Date(Number(ms));
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function showBanner(tone, text, actionLabel, action) {
  el.banner.hidden = false;
  el.banner.dataset.tone = tone;
  el.bannerText.textContent = text;
  if (actionLabel && action) {
    el.bannerAction.hidden = false;
    el.bannerAction.textContent = actionLabel;
    el.bannerAction.onclick = action;
  } else {
    el.bannerAction.hidden = true;
    el.bannerAction.onclick = null;
  }
}

function hideBanner() {
  el.banner.hidden = true;
  el.bannerText.textContent = "";
  el.bannerAction.hidden = true;
  el.bannerAction.onclick = null;
}

function renderStatus(data) {
  const { error, meta, result, refreshSeconds, configured } = data;
  let label = "Live";
  let tone = "ok";
  if (!configured) {
    label = "Setup needed";
    tone = "muted";
  } else if (error?.status === "auth_needed") {
    label = "Auth needed";
    tone = "critical";
  } else if (error) {
    label = "Not updating";
    tone = "warn";
  } else if (!result) {
    label = "Starting…";
    tone = "muted";
  } else if (meta?.fetching) {
    label = "Refreshing…";
    tone = "warn";
  } else if (Number.isFinite(meta?.age) && meta.age > (Number(refreshSeconds) + 15) * 1000) {
    label = "Stale";
    tone = "warn";
  }
  el.status.textContent = label;
  el.status.dataset.tone = tone;
  el.status.title = meta?.lastDurationMs ? `Last fetch took ${meta.lastDurationMs} ms` : "";
}

function renderHeader(data) {
  const result = data.result;
  el.refresh.hidden = data.configured !== true;
  el.settings.hidden = data.configured !== true || ui.forceAuth;

  if (result?.plan?.id) {
    el.plan.textContent = `· ${result.plan.id}`;
    el.plan.hidden = false;
  } else {
    el.plan.hidden = true;
  }

  if (data.configured !== true) {
    el.updated.textContent = "Add your key to begin";
  } else if (result?.fetchedAt) {
    const suffix = data.meta?.fetching ? " · refreshing…" : "";
    el.updated.textContent = `Updated ${formatClock(result.fetchedAt)}${suffix}`;
  } else if (data.meta?.fetching) {
    el.updated.textContent = "Reading…";
  } else if (data.error) {
    el.updated.textContent = "Not updated";
  } else {
    el.updated.textContent = "—";
  }
}

function renderBanner(data) {
  const { error, credential, configured } = data;

  // On first run the connection panel is the call to action; an error banner
  // would claim a key was rejected when none has been entered.
  if (!configured) {
    hideBanner();
    return;
  }

  if (error) {
    const tone = error.status === "auth_needed" ? "critical" : "warn";
    const text =
      error.status === "auth_needed"
        ? "Authentication required — Command Code rejected the stored key."
        : error.status === "network_error"
          ? data.result
            ? "Cannot reach api.commandcode.ai. Showing the last values."
            : "Cannot reach api.commandcode.ai."
          : error.message || "The API returned an error.";
    if (error.status === "auth_needed") {
      showBanner(tone, text, "Update key", () => openAuth());
    } else {
      showBanner(tone, text, "Retry", () => void refreshNow());
    }
    return;
  }

  if (configured && credential?.source && credential.source !== "config.json") {
    showBanner(
      "info",
      `Using credentials from ${credential.source}. A stored config.json key is not in use while that source exists.`,
      "Use a different key",
      () => openAuth(),
    );
    return;
  }

  hideBanner();
}

function renderAuth(data) {
  const configured = data.configured === true;
  const masked = data.credential?.masked;
  const source = data.credential?.source;

  if (configured && masked) {
    el.currentKey.hidden = false;
    el.currentKey.textContent = `Current credential: ${masked}${source ? ` (${source})` : ""}`;
  } else {
    el.currentKey.hidden = true;
  }

  el.cancel.hidden = !configured;
  el.forget.hidden = !configured || source !== "config.json";
}

function renderWindow(key) {
  const card = el.windows[key];
  const result = ui.data?.result;
  const window = result?.[key];
  const display = result?.display ?? {};
  const percentEl = card.querySelector('[data-role="percent"]');
  const bar = card.querySelector('[data-role="bar"]');
  const fill = card.querySelector('[data-role="fill"]');
  const usage = card.querySelector('[data-role="usage"]');
  const reset = card.querySelector('[data-role="reset"]');
  const tag = card.querySelector('[data-role="tag"]');

  if (!window) {
    card.dataset.tone = "muted";
    percentEl.textContent = "—";
    fill.style.width = "0%";
    bar.setAttribute("aria-valuenow", "0");
    bar.setAttribute("aria-valuetext", "not open yet");
    usage.textContent = "not open yet";
    reset.textContent = "";
    if (tag && key !== "monthly") tag.textContent = "";
    return;
  }

  const percent = Number(window.percent) || 0;
  card.dataset.tone = toneFor(percent, ui.data.thresholds);
  percentEl.textContent = display[`${key}Percent`] ?? `${Math.round(percent)}%`;
  fill.style.width = `${clampPercent(percent)}%`;
  bar.setAttribute("aria-valuenow", String(Math.round(clampPercent(percent))));
  bar.setAttribute("aria-valuetext", `${Math.round(percent)} percent used`);
  usage.textContent = display[`${key}Usage`] ?? "—";
  reset.textContent = window.resetAt
    ? `reset in ${display[`${key}ResetIn`] ?? "?"} (${display[`${key}ResetAt`] ?? "?"})`
    : "";
  if (tag && key !== "monthly") tag.textContent = "";
}

function renderStats() {
  const result = ui.data?.result;
  const display = result?.display ?? {};

  el.tokensValue.textContent = display.tokensValue ?? "—";
  el.tokensDetail.textContent = display.tokensDetail ?? "cycle total";

  el.runsValue.textContent = display.runsValue ?? "—";
  el.runsDetail.textContent = display.runsDetail ?? "cycle total";

  if (result?.credits) {
    el.creditsValue.textContent = `${display.creditsUsed ?? "—"} of ${display.creditsLimit ?? "—"} USD`;
    el.creditsDetail.textContent = `${display.creditsRemaining ?? "—"} left · ${display.creditsPercent ?? "—"} used`;
    const percent = clampPercent(result.credits.percent);
    el.creditsFill.style.width = `${percent}%`;
    el.creditsBar.dataset.tone = toneFor(result.credits.percent, ui.data.thresholds);
    el.creditsBar.setAttribute("aria-valuenow", String(Math.round(percent)));
    el.creditsBar.setAttribute("aria-valuetext", `${Math.round(percent)} percent of credits used`);
  } else if (result?.creditsPending) {
    el.creditsValue.textContent = "Loading…";
    el.creditsDetail.textContent = "reading the credit balance";
    el.creditsFill.style.width = "0%";
    el.creditsBar.setAttribute("aria-valuenow", "0");
  } else {
    el.creditsValue.textContent = "—";
    el.creditsDetail.textContent = "no credit pool reported for this plan";
    el.creditsFill.style.width = "0%";
    el.creditsBar.setAttribute("aria-valuenow", "0");
  }
}

function renderCost() {
  const meta = ui.data?.meta ?? {};
  const cost = meta.cost ?? { requests: 0, total: 0, currency: "USD", reported: false };
  const session = meta.sessionCost ?? cost;
  const reported = cost.reported === true;
  const fetching = meta.fetching === true;

  el.costValue.textContent = fetching ? "…" : formatCost(cost.total, cost.currency);
  el.costRequests.textContent = fetching ? "…" : String(cost.requests);
  el.costCharged.textContent = reported ? formatCost(cost.total, cost.currency) : "none";
  el.costSession.textContent = `${plural(session.requests ?? 0, "request", "requests")} · ${formatCost(session.total, session.currency)}`;
  el.costChip.textContent = reported ? "reported by API" : "not charged";
  el.costChip.dataset.tone = reported ? "warn" : "ok";
  el.costNote.textContent = reported
    ? "The API reports a charge for these reads; the amount above is what it returned."
    : "These calls read billing metadata; Command Code reports no charge for them, so refreshing is free.";
}

function renderInterval() {
  const seconds = Number(ui.data?.refreshSeconds) || 0;
  for (const button of el.intervalGroup.querySelectorAll("button[data-seconds]")) {
    const active = Number(button.dataset.seconds) === seconds;
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.dataset.active = active ? "true" : "false";
  }
}

function renderEmpty(data) {
  const error = data.error;
  if (error) {
    el.emptyTitle.textContent = error.status === "auth_needed" ? "Authentication failed" : "Could not load usage";
    el.emptyText.textContent = error.message || "The API did not return usage data.";
    el.emptyRetry.hidden = false;
  } else {
    el.emptyTitle.textContent = "Waiting for the first update…";
    el.emptyText.textContent = "Reading your limits from Command Code.";
    el.emptyRetry.hidden = true;
  }
}

function render(data) {
  if (!data) return;

  // Two in-flight polls can land out of order. A reply older than what is
  // already on screen would resurrect a stale error banner, so drop it.
  const revision = Number(data.meta?.revision ?? data.revision);
  if (Number.isFinite(revision)) {
    if (revision < ui.revision) return;
    ui.revision = revision;
  }

  ui.data = data;

  const configured = data.configured === true;
  const showAuth = !configured || ui.forceAuth;
  const hasResult = Boolean(data.result);

  renderHeader(data);
  renderStatus(data);
  renderBanner(data);

  el.auth.hidden = !showAuth;
  el.dashboard.hidden = showAuth || !hasResult;
  el.empty.hidden = showAuth || hasResult;

  if (showAuth) {
    renderAuth(data);
    return;
  }

  if (hasResult) {
    renderInterval();
    renderWindow("fiveHour");
    renderWindow("weekly");
    renderWindow("monthly");
    renderStats();
    renderCost();
  } else {
    renderEmpty(data);
  }
}

async function tick() {
  if (document.hidden) return;
  try {
    render(await request("/api/state"));
  } catch (error) {
    el.status.textContent = "Offline";
    el.status.dataset.tone = "critical";
    showBanner("critical", "The local server is not responding. Is the terminal still running?", "Reload", () =>
      window.location.reload(),
    );
  }
}

function startPolling() {
  if (ui.pollTimer) return;
  ui.pollTimer = setInterval(() => void tick(), POLL_MS);
}

function openAuth() {
  ui.forceAuth = true;
  el.authMessage.textContent = "";
  render(ui.data);
  el.input.focus();
}

async function saveKey(event) {
  event.preventDefault();
  const value = el.input.value.trim();
  if (!value || ui.busy) return;
  ui.busy = true;
  el.save.disabled = true;
  el.authMessage.textContent = "Checking the key…";
  try {
    const data = await request("/api/key", { method: "POST", body: { apiKey: value } });
    el.input.value = "";
    ui.forceAuth = false;
    el.authMessage.textContent = "";
    render(data);
    startPolling();
  } catch (error) {
    el.authMessage.textContent = friendlyError(error);
  } finally {
    ui.busy = false;
    el.save.disabled = false;
  }
}

async function forgetKey() {
  if (ui.busy) return;
  if (!window.confirm("Remove the API key stored in config.json?")) return;
  ui.busy = true;
  el.forget.disabled = true;
  try {
    const data = await request("/api/key", { method: "DELETE" });
    ui.forceAuth = false;
    render(data);
  } catch (error) {
    el.authMessage.textContent = friendlyError(error);
  } finally {
    ui.busy = false;
    el.forget.disabled = false;
  }
}

async function refreshNow() {
  if (ui.busy) return;
  ui.busy = true;
  el.refresh.disabled = true;
  try {
    render(await request("/api/refresh", { method: "POST" }));
  } catch (error) {
    showBanner("critical", friendlyError(error));
  } finally {
    ui.busy = false;
    el.refresh.disabled = false;
  }
}

async function setIntervalSeconds(seconds) {
  if (ui.busy) return;
  ui.busy = true;
  for (const button of el.intervalGroup.querySelectorAll("button")) button.disabled = true;
  try {
    render(await request("/api/settings", { method: "POST", body: { refreshSeconds: seconds } }));
  } catch (error) {
    showBanner("critical", friendlyError(error), "Reload", () => window.location.reload());
  } finally {
    ui.busy = false;
    for (const button of el.intervalGroup.querySelectorAll("button")) button.disabled = false;
  }
}

el.form.addEventListener("submit", saveKey);
el.forget.addEventListener("click", forgetKey);
el.settings.addEventListener("click", () => openAuth());
el.refresh.addEventListener("click", () => void refreshNow());
el.emptyRetry.addEventListener("click", () => void refreshNow());
el.cancel.addEventListener("click", () => {
  ui.forceAuth = false;
  el.authMessage.textContent = "";
  render(ui.data);
});
el.intervalGroup.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-seconds]");
  if (!button) return;
  const seconds = Number(button.dataset.seconds);
  const current = Number(ui.data?.refreshSeconds);
  if (seconds === current) return;
  void setIntervalSeconds(seconds);
});

el.toggle.addEventListener("click", () => {
  const reveal = el.input.type === "password";
  el.input.type = reveal ? "text" : "password";
  el.toggle.textContent = reveal ? "Hide" : "Show";
  el.toggle.setAttribute("aria-pressed", reveal ? "true" : "false");
  el.input.focus();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void tick();
});

void tick();
startPolling();

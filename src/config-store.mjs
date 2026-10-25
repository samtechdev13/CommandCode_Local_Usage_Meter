/**
 * Configuration persistence for the local dashboard.
 *
 * The dashboard never rewrites keys it does not own: a save merges into the
 * parsed JSON, so `$comment` notes, endpoint overrides and anything the user
 * added by hand survive. The file is written with mode 600 through a temporary
 * file and a rename, so an interrupted save cannot truncate a working config.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { normalizeConfig, resolveCredential } from "./limits.mjs";

/** Intervals the dashboard offers; the API rejects anything else. */
export const ALLOWED_REFRESH_SECONDS = Object.freeze([30, 60, 90, 120]);

export const DEFAULT_PORT = 4317;

export function readRawConfig(configPath) {
  if (!existsSync(configPath)) return {};
  const text = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(String(text).replace(/^\uFEFF/, ""));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config.json must contain a JSON object");
  }
  return parsed;
}

/** Server-only settings that the vendored engine has no opinion about. */
export function serverSettings(raw = {}) {
  const candidate = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.server : undefined;
  const server =
    candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : {};
  const port =
    Number.isInteger(server.port) && server.port >= 1024 && server.port <= 65535 ? server.port : DEFAULT_PORT;
  return { port, openBrowser: server.openBrowser !== false };
}

export function loadAppConfig(configPath) {
  const raw = readRawConfig(configPath);
  return { raw, config: normalizeConfig(raw), server: serverSettings(raw) };
}

/** Apply the `--url` override without persisting it. */
export function withBaseUrl(config, baseUrl) {
  const value = String(baseUrl ?? "").trim();
  if (!value) return config;
  return normalizeConfig({ ...config, endpoints: { ...config.endpoints, baseUrl: value } });
}

function writeConfigFile(configPath, value) {
  const directory = dirname(configPath);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, configPath);
  chmodSync(configPath, 0o600);
}

export function saveConfigPatch(configPath, patch) {
  const raw = readRawConfig(configPath);
  const next = { ...raw, ...patch };
  writeConfigFile(configPath, next);
  return { raw: next, config: normalizeConfig(next), server: serverSettings(next) };
}

export function setApiKey(configPath, apiKey) {
  const value = String(apiKey ?? "").trim();
  if (!value) throw Object.assign(new Error("API key is empty"), { code: "empty_key" });
  if (value.length > 4096) throw Object.assign(new Error("API key is too long"), { code: "long_key" });
  if (/\s/.test(value)) throw Object.assign(new Error("API key must not contain spaces"), { code: "invalid_key" });
  return saveConfigPatch(configPath, { apiKey: value });
}

export function clearApiKey(configPath) {
  return saveConfigPatch(configPath, { apiKey: "" });
}

export function setRefreshSeconds(configPath, seconds) {
  const value = Number(seconds);
  if (!ALLOWED_REFRESH_SECONDS.includes(value)) {
    throw Object.assign(new Error(`refreshSeconds must be one of ${ALLOWED_REFRESH_SECONDS.join(", ")}`), {
      code: "invalid_refresh",
    });
  }
  return saveConfigPatch(configPath, { refreshSeconds: value });
}

/** `user_abcd••••7f2a` — enough to recognise a key, never enough to use it. */
export function maskKey(token) {
  const value = String(token ?? "");
  if (value.length <= 12) return "••••";
  return `${value.slice(0, 5)}••••${value.slice(-4)}`;
}

/**
 * Whether a credential can be resolved, and from where. The token itself never
 * leaves this function: only the source description and a masked form do.
 */
export function credentialStatus(config) {
  const credential = resolveCredential(config);
  if (credential.token) {
    return { configured: true, source: credential.source, masked: maskKey(credential.token) };
  }
  return {
    configured: false,
    source: "none",
    reason: credential.error,
    message: credential.message,
  };
}

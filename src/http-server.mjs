/**
 * Loopback HTTP surface for the dashboard.
 *
 * Safety properties this file is responsible for:
 *   - the socket only ever binds 127.0.0.1 (done by server.mjs), and requests
 *     from anything but loopback are refused;
 *   - the Host header must be a local name, which defeats DNS rebinding;
 *   - every mutating route needs a per-run token injected into the page, a
 *     JSON content type and, when a browser sends one, a same-origin Origin;
 *   - static files come from an in-memory allowlist, so no request path ever
 *     reaches the filesystem;
 *   - the API key is written but never returned: responses carry only a masked
 *     form and a source description.
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import {
  ALLOWED_REFRESH_SECONDS,
  clearApiKey,
  setApiKey,
  setRefreshSeconds,
  withBaseUrl,
} from "./config-store.mjs";
import { redact } from "./limits.mjs";

const MAX_BODY_BYTES = 8 * 1024;

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/styles.css", "styles.css"],
  ["/favicon.svg", "favicon.svg"],
]);

const MIME_TYPES = new Map([
  ["index.html", "text/html; charset=utf-8"],
  ["app.js", "text/javascript; charset=utf-8"],
  ["styles.css", "text/css; charset=utf-8"],
  ["favicon.svg", "image/svg+xml"],
]);

const SECURITY_HEADERS = Object.freeze({
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
});

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendMethodNotAllowed(response, allowed) {
  response.writeHead(405, { ...SECURITY_HEADERS, allow: allowed.join(", "), "content-type": "application/json" });
  response.end(JSON.stringify({ error: "method_not_allowed", allowed }));
}

function isLoopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function hostAllowed(request) {
  const host = String(request.headers.host ?? "").toLowerCase();
  if (!host) return false;
  const port = request.socket.localPort;
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]).has(host);
}

function localOrigins(port) {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
}

/** Read a bounded JSON object body; oversized or malformed input is a 4xx. */
function readJsonBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const fail = (status, code) => {
      request.removeAllListeners("data");
      request.resume();
      reject(Object.assign(new Error(code), { status, code }));
    };
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) return fail(413, "body_too_large");
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return reject(Object.assign(new Error("invalid_json"), { status: 400, code: "invalid_json" }));
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error("invalid_json"), { status: 400, code: "invalid_json" }));
      }
    });
    request.on("error", () => reject(Object.assign(new Error("request_error"), { status: 400, code: "request_error" })));
  });
}

export function createAppServer({ meter, configPath, publicDir, version = "unknown", overrides = {} }) {
  const token = randomBytes(24).toString("base64url");

  const assets = new Map();
  for (const file of new Set(STATIC_FILES.values())) {
    assets.set(file, readFileSync(join(publicDir, file)));
  }

  const serveAsset = (response, file, headOnly) => {
    const raw = assets.get(file);
    const body = file === "index.html" ? Buffer.from(raw.toString("utf8").replaceAll("__CMETER_TOKEN__", token)) : raw;
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "content-type": MIME_TYPES.get(file) ?? "application/octet-stream",
      "content-length": body.length,
    });
    response.end(headOnly ? undefined : body);
  };

  /** Why a mutation is refused, or null when it may proceed. */
  const mutationRefusal = (request) => {
    const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
    if (request.method !== "DELETE" && !contentType.startsWith("application/json")) {
      return "content_type_required";
    }
    if (String(request.headers["x-cmeter-token"] ?? "") !== token) return "forbidden_token";
    const origin = request.headers.origin;
    if (origin && !localOrigins(request.socket.localPort).has(String(origin).toLowerCase())) {
      return "forbidden_origin";
    }
    const site = request.headers["sec-fetch-site"];
    if (site && site !== "same-origin" && site !== "none") return "forbidden_site";
    return null;
  };

  const applySavedConfig = (saved) => {
    meter.setConfig(withBaseUrl(saved.config, overrides.baseUrl));
  };

  const server = createServer(async (request, response) => {
    try {
      if (!isLoopback(request.socket.remoteAddress)) {
        return sendJson(response, 403, { error: "forbidden_client" });
      }
      if (!hostAllowed(request)) {
        return sendJson(response, 403, { error: "forbidden_host" });
      }

      let pathname;
      try {
        pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      } catch {
        return sendJson(response, 400, { error: "bad_request" });
      }

      if (request.method === "GET" || request.method === "HEAD") {
        const file = STATIC_FILES.get(pathname);
        if (file) return serveAsset(response, file, request.method === "HEAD");
      }

      if (!pathname.startsWith("/api/")) {
        return sendJson(response, 404, { error: "not_found" });
      }

      if (pathname === "/api/health") {
        if (request.method !== "GET") return sendMethodNotAllowed(response, ["GET"]);
        return sendJson(response, 200, {
          ok: true,
          app: "usage-meter-local",
          version,
          pid: process.pid,
        });
      }

      if (pathname === "/api/state") {
        if (request.method !== "GET") return sendMethodNotAllowed(response, ["GET"]);
        return sendJson(response, 200, meter.snapshot({ autoRefresh: true }));
      }

      // Everything past this point can change state, so it is guarded.
      if (MUTATING_METHODS.has(request.method)) {
        const refusal = mutationRefusal(request);
        if (refusal) return sendJson(response, 403, { error: refusal });
      }

      if (pathname === "/api/refresh") {
        if (request.method !== "POST") return sendMethodNotAllowed(response, ["POST"]);
        void meter.refresh("request");
        return sendJson(response, 202, meter.snapshot());
      }

      if (pathname === "/api/settings") {
        if (request.method !== "POST") return sendMethodNotAllowed(response, ["POST"]);
        const body = await readJsonBody(request);
        const seconds = Number(body.refreshSeconds);
        if (!ALLOWED_REFRESH_SECONDS.includes(seconds)) {
          return sendJson(response, 400, {
            error: "invalid_refresh_seconds",
            allowed: [...ALLOWED_REFRESH_SECONDS],
          });
        }
        applySavedConfig(setRefreshSeconds(configPath, seconds));
        return sendJson(response, 200, meter.snapshot());
      }

      if (pathname === "/api/key") {
        if (request.method === "POST") {
          const body = await readJsonBody(request);
          try {
            applySavedConfig(setApiKey(configPath, body.apiKey));
          } catch (error) {
            return sendJson(response, 400, { error: error.code ?? "invalid_api_key", message: error.message });
          }
          meter.reset();
          void meter.refresh("key");
          return sendJson(response, 200, { ok: true, ...meter.snapshot() });
        }
        if (request.method === "DELETE") {
          applySavedConfig(clearApiKey(configPath));
          meter.reset();
          return sendJson(response, 200, { ok: true, ...meter.snapshot() });
        }
        return sendMethodNotAllowed(response, ["POST", "DELETE"]);
      }

      return sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (status === 500) console.error(redact(`usage-meter: ${error?.stack ?? error}`));
      if (!response.headersSent) {
        sendJson(response, status, { error: error?.code ?? "internal" });
      } else {
        response.end();
      }
    }
  });

  return { server, token };
}

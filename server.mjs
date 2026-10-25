#!/usr/bin/env node
/**
 * Entry point for the local dashboard.
 *
 *   node server.mjs [--port N] [--config PATH] [--url URL] [--no-open]
 *
 * Binds 127.0.0.1 only. If the preferred port is already serving this app, the
 * browser is opened to that instance and this process exits, so double-clicking
 * twice never starts a second poller.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadAppConfig, withBaseUrl } from "./src/config-store.mjs";
import { createAppServer } from "./src/http-server.mjs";
import { Meter } from "./src/state.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const HOST = "127.0.0.1";

function parseArgs(argv) {
  const options = { port: null, configPath: "", url: "", open: true, help: false, version: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") options.port = Number(argv[++index]);
    else if (arg.startsWith("--port=")) options.port = Number(arg.slice("--port=".length));
    else if (arg === "--config") options.configPath = argv[++index] ?? "";
    else if (arg.startsWith("--config=")) options.configPath = arg.slice("--config=".length);
    else if (arg === "--url") options.url = argv[++index] ?? "";
    else if (arg.startsWith("--url=")) options.url = arg.slice("--url=".length);
    else if (arg === "--no-open") options.open = false;
    else if (arg === "--host") {
      const value = argv[++index] ?? "";
      if (value !== HOST) {
        console.error(`usage-meter: refusing --host ${value}; this server only binds ${HOST}.`);
        process.exit(3);
      }
    } else if (arg.startsWith("--host=")) {
      if (arg.slice("--host=".length) !== HOST) {
        console.error(`usage-meter: refusing ${arg}; this server only binds ${HOST}.`);
        process.exit(3);
      }
    } else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--version" || arg === "-V") options.version = true;
    else {
      console.error(`usage-meter: unrecognised argument: ${arg}`);
      process.exit(3);
    }
  }
  return options;
}

function packageInfo() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  } catch {
    return { version: "unknown" };
  }
}

const options = parseArgs(process.argv.slice(2));
const { version } = packageInfo();

if (options.port !== null && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)) {
  console.error("usage-meter: --port must be an integer between 0 and 65535.");
  process.exit(3);
}

if (options.help) {
  console.log(
    [
      "Usage: node server.mjs [options]",
      "",
      "  --port N         listen on this loopback port (default: 4317, from config.server.port)",
      "  --config PATH    use an alternative config.json",
      "  --url URL        override the API base URL (for test/fixture-server.mjs)",
      "  --no-open        do not open a browser",
      "  -h, --help       this help",
      "  -V, --version    print the version",
      "",
      "The server binds 127.0.0.1 only; the API key never leaves this machine.",
    ].join("\n"),
  );
  process.exit(0);
}

if (options.version) {
  console.log(`usage-meter-local ${version}`);
  process.exit(0);
}

const configPath = options.configPath ? resolve(options.configPath) : join(ROOT, "config.json");

let loaded;
try {
  loaded = loadAppConfig(configPath);
} catch (error) {
  console.error(`usage-meter: could not read ${configPath}: ${error.message}`);
  process.exit(1);
}

const initialConfig = withBaseUrl(loaded.config, options.url);
const overrides = { baseUrl: options.url };
const meter = new Meter({ config: initialConfig, version });

function listen(server, port) {
  return new Promise((resolveListening, rejectListening) => {
    const onError = (error) => {
      server.off("listening", onListening);
      rejectListening(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListening();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
}

/** Is the listener on this port already an instance of this app? */
async function isOurInstance(port) {
  try {
    const response = await fetch(`http://${HOST}:${port}/api/health`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(800),
    });
    const body = await response.json();
    return body?.app === "usage-meter-local";
  } catch {
    return false;
  }
}

function openBrowser(url) {
  const platform = process.platform;
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Opening a browser is a convenience; the URL is printed either way.
  }
}

async function main() {
  const preferred = Number.isInteger(options.port) ? options.port : loaded.server.port;
  const attempts = preferred === 0 ? 1 : 10;
  let bound = null;
  let listeningPort = null;

  for (let offset = 0; offset < attempts; offset += 1) {
    const candidate = preferred === 0 ? 0 : preferred + offset;
    const app = createAppServer({ meter, configPath, publicDir: join(ROOT, "public"), version, overrides });
    try {
      await listen(app.server, candidate);
      bound = app.server;
      listeningPort = app.server.address().port;
      break;
    } catch (error) {
      if (error?.code !== "EADDRINUSE") {
        console.error(`usage-meter: could not listen on ${HOST}:${candidate}: ${error.message}`);
        process.exit(1);
      }
      if (await isOurInstance(candidate)) {
        const url = `http://${HOST}:${candidate}`;
        console.log(`usage-meter: already running at ${url}`);
        if (options.open && loaded.server.openBrowser) openBrowser(url);
        process.exit(0);
      }
    }
  }

  if (!bound) {
    console.error(`usage-meter: no free port near ${preferred}.`);
    process.exit(1);
  }

  const url = `http://${HOST}:${listeningPort}`;
  console.log(`usage-meter: listening on ${url} (local only)`);
  console.log(`usage-meter: upstream ${initialConfig.endpoints.baseUrl}`);
  console.log("usage-meter: press Ctrl+C to stop");

  void meter.refresh("startup");

  if (options.open && loaded.server.openBrowser) openBrowser(url);

  const shutdown = () => {
    bound.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await main();

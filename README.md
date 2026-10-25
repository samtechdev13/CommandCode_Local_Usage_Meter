# Usage Meter — local web dashboard

A local-only web dashboard for **Command Code** usage limits. Start one Node
process, open `http://127.0.0.1:4317`, and see the 5-hour, weekly and monthly
windows, tokens, runs and USD credits — with the same numbers the CLI reports.

Nothing leaves the machine except four read-only calls to `api.commandcode.ai`.
There are no dependencies, no build step, no CDN assets, no cookies, no
analytics, and the API key is never sent to the page.

```
Command Code · individual-goat                                    ● Live  Updated 11:29:30
  ┌ 5 hours ── 36% ────────────────  5.09 / 14    reset in 2h 18m ─┐
  ┌ Weekly ─── 64% ────────────────  22.4 / 35    reset in 5d 3h ──┐
  ┌ Monthly ──  9% ────────────────  6.41 / 70    reset in 22d ────┐
  Tokens 473.0 M · Runs 1601 · Credits 6.41 of 70 USD (63.59 left)
  Cost of refreshing: $0.00 · 5 requests · not charged
```

## Quick start

Requires **Node.js 18.17+** and nothing else. From the project folder:

```bash
node server.mjs            # or: npm start
```

The server prints the URL and opens the browser. On first run it asks for a
Provider-API key, which you can create at
[commandcode.ai/settings/keys](https://commandcode.ai/settings/keys). If you are
already signed in with the Command Code CLI, its local auth file is detected
automatically and there is nothing to paste.

Options:

```
node server.mjs --port 4317      # preferred loopback port
node server.mjs --config PATH    # alternative config.json
node server.mjs --url URL        # alternative API base (fixture server)
node server.mjs --no-open        # do not launch a browser
```

If the chosen port is already serving this app, the browser is opened to that
instance and the second process exits.

## Refresh interval

The segmented control switches between **30, 60, 90 and 120 seconds** and is
saved to `config.json`. The browser polls a cached snapshot every 2 seconds; the
server fetches upstream only when the cache is older than the chosen interval.
Closing the page therefore stops all outbound traffic immediately. `Refresh now`
forces a fetch.

The rolling windows arrive first from the fast credits call; the USD credits,
tokens and runs hydrate a moment later, so opening the page never waits on the
slow tail.

## What refreshing costs

Command Code's `/alpha/*` endpoints return billing metadata, so reading them is
not billed. That cannot be guaranteed for an undocumented API, so the cost card
shows exactly what the API reports:

- **Cost this refresh** — summed from any `x-request-cost` header or
  `requestCost` field; `$0.00` when nothing is reported.
- **Requests this refresh** — how many calls the fetch made.
- **Reported charges** — `none` unless the API announced one.
- **This session** — requests and cost since the server started.

The account's real spend is kept separate: the Credits card shows
`used of limit (remaining left)` for the current billing cycle, derived the same
way the CLI derives it (spend plus remaining pools).

## Where the numbers come from

| Value | Source |
|---|---|
| 5 hours, weekly | `windowLimits.fiveHour` / `.weekly` from `/alpha/billing/credits` |
| Monthly | derived: cycle spend + remaining credit pools |
| Tokens, runs | `/alpha/usage/summary` |
| Credits | `totalCost` vs the pool sum from `/alpha/billing/credits` |
| Billing period | `/alpha/billing/subscriptions` |

`/alpha/*` is undocumented. Every path and the base URL are overridable in
`config.json`, so a change can be fixed without touching the code.

## Security model

- The HTTP server binds **`127.0.0.1` only** and refuses any other `--host`.
- The `Host` header must name the local machine, defeating DNS rebinding.
- Mutating routes (`POST /api/key`, `POST /api/settings`, …) require a per-run
  token injected into the page, a JSON content type and a same-origin `Origin`
  when a browser sends one. No CORS headers are emitted.
- Static assets come from an in-memory allowlist, so no request path touches the
  filesystem.
- CSP is `default-src 'self'` with no inline script or style; the page loads no
  remote assets.
- The API key is written to `config.json` with **mode 600** through a temporary
  file and a rename. Responses carry only a masked form (`test-••••7890`) and the
  source description; the raw key never reaches the page or a log.
- Credentials follow the same precedence as the CLI: `COMMANDCODE_API_KEY` →
  `config.apiKey` → `~/.commandcode/auth.json` → `~/.pi/agent/auth.json`
  (the last two are read-only). When an environment or CLI credential is in use,
  the dashboard says so.
- Removing the stored key from the connection panel clears it from disk and
  discards the cached numbers.

## Configuration

`config.json` is optional until the first save. Unknown keys, `$comment` notes
and endpoint overrides are preserved when the dashboard writes the file.

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | `""` | Provider-API key (written by the connection panel) |
| `apiKeyEnv` | `COMMANDCODE_API_KEY` | environment variable checked for the key |
| `refreshSeconds` | `120` | 30 / 60 / 90 / 120 from the UI |
| `language` | `en` | interface language table used for dates/numbers (`en`, `it`, `zh`) |
| `thresholds.warn` | `60` | amber threshold |
| `thresholds.critical` | `85` | red threshold |
| `endpoints.*` | `/alpha/...` | API paths and base URL |
| `creditFiles` | CLI auth paths | read-only credential fallbacks |
| `requestTimeoutMs` | `8000` | upstream request timeout |
| `server.port` | `4317` | preferred loopback port |
| `server.openBrowser` | `true` | open a browser at startup |

`config.json` is gitignored. Only `config.example.json` is committed.

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | cached snapshot; may start a background refresh |
| POST | `/api/refresh` | force a fetch, answers `202` immediately |
| POST | `/api/settings` | `{ "refreshSeconds": 30 }` (whitelist) |
| POST | `/api/key` | store a key; returns only the masked form |
| DELETE | `/api/key` | remove the stored key |
| GET | `/api/health` | liveness and app identity |

## Tests

```bash
npm test
```

Covers payload parsing, monthly derivation, credential precedence, config
persistence and permissions, request-cost accounting, the HTTP guards (token,
Origin, Host, body size), the key-save/401/delete transitions, and a scan that
refuses to commit key-shaped strings or remote assets.

To exercise the app without a real key:

```bash
node test/fixture-server.mjs --port 8787 --grow
node server.mjs --port 4317 --url http://127.0.0.1:8787 --no-open
# paste any key the fixture accepts: test-key-1234567890
```

## Layout

```
server.mjs                 entry point: args, port selection, browser
src/limits.mjs             vendored meter engine (parsing, credentials, formatting)
src/i18n.mjs, lang/        vendored language tables
src/config-store.mjs       atomic 0600 config writes, key masking
src/state.mjs              cache, fetch, partial delivery, stale handling
src/cost.mjs               request counting and reported-cost extraction
src/http-server.mjs        routes, static allowlist, security guards
public/                    index.html, app.js, styles.css, favicon.svg
test/                      fixture server, unit and integration suites
```

`src/limits.mjs` and `src/i18n.mjs` were copied from **commandcode-meter v1.3.0**
on 2026-10-25. This project owns those copies and may change them; they are no
longer synced automatically.

Assets are read into memory when the server starts, so restart it after editing
`public/` or `src/`.

## Limitations

- One account per instance. The vendored engine supports `profiles`, but the UI
  does not expose them yet.
- No history or graphs; the dashboard shows the current windows only.
- The dashboard's own strings are English; the engine's date, number and token
  formatting follows `language`.

## Uninstalling

Stop the server, then delete the folder. It writes nothing outside it except the
optional read-only lookup of the Command Code CLI auth file.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".cache", "test"]);
const TEXT_EXTENSIONS = new Set([".mjs", ".js", ".json", ".html", ".css", ".svg"]);
const SKIP_FILES = new Set(["config.json"]);

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...walk(join(directory, entry.name)));
      continue;
    }
    if (SKIP_FILES.has(entry.name)) continue;
    if (!TEXT_EXTENSIONS.has(extname(entry.name))) continue;
    files.push(join(directory, entry.name));
  }
  return files;
}

const FILES = walk(ROOT).map((path) => ({ path, text: readFileSync(path, "utf8") }));

test("the repository carries no key-shaped strings", () => {
  const keyShape = /\b(?:user|sk|cc|cmd)[-_][A-Za-z0-9_-]{20,}\b/;
  const offenders = FILES.filter((file) => keyShape.test(file.text)).map((file) => file.path);
  assert.deepEqual(offenders, []);
});

test("the example config ships an empty key and is committed, the real one is ignored", () => {
  const example = JSON.parse(readFileSync(join(ROOT, "config.example.json"), "utf8"));
  assert.equal(example.apiKey, "");
  assert.equal(example.refreshSeconds, 60);

  const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
  assert.match(ignore, /^config\.json$/m);
  assert.match(ignore, /^config\.json\.tmp-\*$/m);
  assert.match(ignore, /^\.cache\/$/m);
  assert.match(ignore, /^\.env$/m);
  assert.match(ignore, /^\.commandcode\/$/m);
  assert.match(ignore, /^!config\.example\.json$/m);
});

test("the page loads every asset from the local server", () => {
  const forbidden = [
    /<script[^>]+src=["']https?:/i,
    /<link[^>]+href=["']https?:\/\/[^"']+\.css/i,
    /@import\s+url\(\s*["']?https?:/i,
    /https?:\/\/[^"')\s]+\/(?:app|main|styles?|bundle)\.(?:js|css)/i,
  ];
  for (const file of FILES) {
    for (const pattern of forbidden) {
      assert.equal(pattern.test(file.text), false, `${file.path} must not load a remote asset`);
    }
  }

  const html = readFileSync(join(ROOT, "public", "index.html"), "utf8");
  assert.match(html, /src="\/app\.js"/);
  assert.match(html, /href="\/styles\.css"/);
});

test("the client never renders API data as HTML", () => {
  const client = readFileSync(join(ROOT, "public", "app.js"), "utf8");
  assert.equal(/\.innerHTML\s*=/.test(client), false);
  assert.equal(/insertAdjacentHTML/.test(client), false);
  assert.equal(/document\.write/.test(client), false);
});

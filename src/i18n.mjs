// Vendored from commandcode-meter v1.3.0 (src/i18n.mjs) on 2026-10-25.
// This project owns this copy and may modify it; see README.md for provenance.
/**
 * Language tables for every surface: the tray, the executable and the CLI all
 * read the same `lang/*.json` files, so a translated string cannot drift
 * between them.
 *
 * The active table is process-wide and set once at startup from `language` in
 * the configuration (`en`, `it`, `zh`, or `auto` to follow the operating
 * system). A key missing from the active table falls back to English and, if
 * English does not have it either, to the key itself: a visible `panel.tokens`
 * in the interface is a bug report, not a crash.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LANG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "lang");

/** Languages shipped in the repository, in selector order. */
export const LANGUAGES = Object.freeze(["en", "it", "zh"]);

/** Language used when nothing is configured, or when a lookup fails. */
export const DEFAULT_LANGUAGE = "en";

/** Market locale each language formats numbers and dates with. */
const LOCALES = Object.freeze({ en: "en-US", it: "it-IT", zh: "zh-CN" });

/** Environment prefixes a POSIX or Windows system reports its locale with. */
const LOCALE_ENV = ["LC_ALL", "LC_MESSAGES", "LANG"];

const tables = new Map();
let active = DEFAULT_LANGUAGE;
let fallbackNotice = "";

function table(code) {
  if (tables.has(code)) return tables.get(code);
  const path = join(LANG_DIR, `${code}.json`);
  let loaded = null;
  if (existsSync(path)) {
    try {
      loaded = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      loaded = null;
    }
  }
  tables.set(code, loaded);
  return loaded;
}

/** Whether a language file exists and parses. */
export function hasLanguage(code) {
  return table(String(code)) !== null;
}

/** Every language that actually loaded, for selectors and diagnostics. */
export function availableLanguages() {
  return LANGUAGES.filter((code) => hasLanguage(code));
}

/** The language code a payload is currently rendered in. */
export function currentLanguage() {
  return active;
}

/** Market locale of the active language, for `toLocaleString` and `Intl`. */
export function currentLocale() {
  return LOCALES[active] ?? LOCALES[DEFAULT_LANGUAGE];
}

/** A fallback message recorded by the last `setLanguage`, or an empty string. */
export function languageFallbackNotice() {
  return fallbackNotice;
}

/** Map a system locale such as `it_IT.UTF-8` or `zh-Hans-CN` to a shipped code. */
export function detectSystemLanguage(env = process.env) {
  const raw = LOCALE_ENV.map((name) => env?.[name]).find((value) => value && String(value).trim());
  const tag = String(raw ?? "").trim().toLowerCase();
  if (!tag) {
    const intl = Intl.DateTimeFormat().resolvedOptions().locale ?? "";
    const base = intl.toLowerCase();
    if (base.startsWith("it")) return "it";
    if (base.startsWith("zh")) return "zh";
    return DEFAULT_LANGUAGE;
  }
  const base = tag.split(/[._-]/)[0];
  if (base === "it") return "it";
  if (base === "zh") return "zh";
  return DEFAULT_LANGUAGE;
}

/**
 * Select the language for this process.
 * @param requested - `en`, `it`, `zh`, `auto`, or anything else to keep English.
 * @returns the code that is now active.
 */
export function setLanguage(requested) {
  const wanted = String(requested ?? "").trim().toLowerCase();
  fallbackNotice = "";
  if (!wanted || wanted === DEFAULT_LANGUAGE) {
    active = DEFAULT_LANGUAGE;
    return active;
  }
  const code = wanted === "auto" ? detectSystemLanguage() : wanted;
  if (!LANGUAGES.includes(code)) {
    active = DEFAULT_LANGUAGE;
    fallbackNotice = t("language.unknown", { code: wanted });
    return active;
  }
  if (!hasLanguage(code)) {
    active = DEFAULT_LANGUAGE;
    fallbackNotice = t("language.missingFile", { code });
    return active;
  }
  active = code;
  return active;
}

function lookup(code, key) {
  const source = table(code);
  if (!source) return undefined;
  return key.split(".").reduce((node, part) => (node && typeof node === "object" ? node[part] : undefined), source);
}

/** Translate one key, substituting `{placeholders}` from `params`. */
export function t(key, params) {
  let value = lookup(active, key);
  if (value === undefined && active !== DEFAULT_LANGUAGE) value = lookup(DEFAULT_LANGUAGE, key);
  if (typeof value !== "string") return key;
  if (!params) return value;
  return value.replace(/\{([a-zA-Z]+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
}

/**
 * Compare a table against English, for the coverage test and for `--language`
 * diagnostics.
 * @returns keys the language is missing, or would add.
 */
export function compareLanguage(code) {
  const flatten = (obj, prefix = "") =>
    Object.entries(obj ?? {}).flatMap(([k, v]) => (v && typeof v === "object" ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
  const base = new Set(flatten(table(DEFAULT_LANGUAGE)));
  const other = new Set(flatten(table(code)));
  return {
    count: other.size,
    missing: [...base].filter((k) => !other.has(k)),
    extra: [...other].filter((k) => !base.has(k)),
  };
}

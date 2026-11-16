import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * The closed set of theme design tokens is declared twice — the renderer needs
 * it to duplicate a built-in theme, the shared Rust core validates what lands
 * on disk — and neither language can import the other's list.
 *
 * Drift between them is silent and nasty in both directions: a token only the
 * renderer knows gets rejected as "unknown" on save, and a token only the
 * service knows is never copied when duplicating, so every new theme is missing
 * it. This test is the seam that catches that.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const TS_FILE = join(repoRoot, "packages/desktop/src/lib/themes/tokens.ts");
const RS_FILE = join(repoRoot, "packages/plugin-core/src/theme/tokens.rs");
const SERVICE_FILE = join(repoRoot, "packages/service/src/domain/themes/tokens.rs");

/** Extract the `"--token",` entries from a bracketed list, ignoring comments. */
function tokensBetween(source, startMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `could not find ${startMarker}`);
  const end = source.indexOf("];", start);
  assert.notEqual(end, -1, `unterminated list after ${startMarker}`);
  return [...source.slice(start, end).matchAll(/"(--[a-z0-9-]+)"/g)].map((m) => m[1]);
}

function readTsTokens() {
  return tokensBetween(readFileSync(TS_FILE, "utf8"), "export const THEME_TOKEN_KEYS = [");
}

function readRustTokens() {
  return tokensBetween(readFileSync(RS_FILE, "utf8"), "pub const REQUIRED_TOKENS: &[&str] = &[");
}

function readTsOptionalTokens() {
  return tokensBetween(readFileSync(TS_FILE, "utf8"), "export const THEME_OPTIONAL_TOKEN_KEYS = [");
}

function readRustOptionalTokens() {
  return tokensBetween(readFileSync(RS_FILE, "utf8"), "pub const OPTIONAL_TOKENS: &[&str] = &[");
}

test("the frontend and service theme token lists are identical", () => {
  const ts = readTsTokens();
  const rs = readRustTokens();
  assert.ok(ts.length > 50, `expected a full token set, got ${ts.length}`);
  assert.deepEqual(rs, ts, "plugin-core theme tokens must match lib/themes/tokens.ts");
});

test("the service consumes the shared Rust theme tokens", () => {
  const source = readFileSync(SERVICE_FILE, "utf8");
  assert.match(source, /pub use cadencr_plugin_core::theme::tokens::\*;/);
  assert.doesNotMatch(source, /pub const (?:REQUIRED|OPTIONAL)_TOKENS/);
});

test("the optional chrome token lists are identical too", () => {
  const ts = readTsOptionalTokens();
  const rs = readRustOptionalTokens();
  assert.ok(ts.length > 0, "expected an optional token list");
  assert.deepEqual(rs, ts, "the OPTIONAL_TOKENS lists drifted");
});

test("no token appears in both tiers", () => {
  // A token in both would be required and optional at once: the service would
  // demand it and the schema would say it may be left out.
  const required = new Set(readTsTokens());
  for (const token of readTsOptionalTokens()) {
    assert.ok(!required.has(token), `${token} is in both token tiers`);
  }
});

test("neither list repeats a token", () => {
  for (const [label, tokens] of [
    ["tokens.ts", readTsTokens()],
    ["tokens.rs", readRustTokens()],
    ["tokens.ts (optional)", readTsOptionalTokens()],
    ["tokens.rs (optional)", readRustOptionalTokens()],
  ]) {
    assert.equal(new Set(tokens).size, tokens.length, `${label} has a duplicate token`);
  }
});

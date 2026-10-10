// Shared, side-effect-light helpers for the two dev `.env` files, used by
// scripts/setup-dev.mjs, scripts/doctor.mjs and scripts/configure-worktree-dev.mts.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

export const SERVICE_ENV = "packages/service/.env";
export const DESKTOP_ENV = "packages/desktop/.env";
// Mirrors REQUIRED_DEV_ENV_KEYS in packages/service/src/dev_env.rs.
export const REQUIRED_SERVICE_KEYS = [
  "CADENCR_DB_PATH",
  "CADENCR_RUST_PORT",
  "CADENCR_FRONTEND_PORT",
  "CADENCR_AUTH_TOKEN",
];

/** Parse a `.env` file, or return null when it does not exist. */
export function readEnvFile(root, relativePath) {
  const filePath = join(root, relativePath);
  if (!existsSync(filePath)) return null;
  return parseEnv(readFileSync(filePath, "utf8"));
}

/** Missing, blank, or still the `.env.example` placeholder (`replace-with-…`). */
export function isPlaceholderToken(value) {
  return value === undefined || value.trim() === "" || value.trim().startsWith("replace-with");
}

export function generateToken() {
  return randomBytes(32).toString("hex");
}

/**
 * Replace `KEY=value` lines in place (appending missing keys) so comments and
 * unrelated settings in a developer's `.env` survive. An `undefined` value
 * removes the key.
 */
export function setEnvValues(text, values) {
  let next = text;
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      next = next.replace(new RegExp(`^${key}=.*(?:\\r?\\n|$)`, "gm"), "");
      continue;
    }
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    // A replacer function keeps `$` in a token from being read as a pattern.
    next = pattern.test(next)
      ? next.replace(pattern, () => line)
      : `${next.replace(/\s*$/, "")}\n${line}\n`;
  }
  return next;
}

/** Read-modify-write `values` into an existing `.env` file (see `setEnvValues`). */
export function updateEnvFile(root, relativePath, values) {
  const filePath = join(root, relativePath);
  writeFileSync(filePath, setEnvValues(readFileSync(filePath, "utf8"), values));
}

/** A TCP port number, or null for anything else (unset, blank, out of range). */
export function validPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

/** The port a URL connects to (its scheme default when it names none), or null. */
export function urlPort(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return validPort(url.port || (url.protocol === "https:" ? "443" : "80"));
  } catch {
    return null;
  }
}

/** Port/URL disagreements between the two `.env` files, as readable problems. */
export function portMismatches(service, desktop) {
  const problems = [];
  if (validPort(service.CADENCR_FRONTEND_PORT) !== validPort(desktop.VITE_FRONTEND_PORT)) {
    problems.push(
      `${SERVICE_ENV} CADENCR_FRONTEND_PORT=${service.CADENCR_FRONTEND_PORT ?? "<unset>"} but ` +
        `${DESKTOP_ENV} VITE_FRONTEND_PORT=${desktop.VITE_FRONTEND_PORT ?? "<unset>"}`,
    );
  }
  if (validPort(service.CADENCR_RUST_PORT) !== urlPort(desktop.VITE_API_URL)) {
    problems.push(
      `${SERVICE_ENV} CADENCR_RUST_PORT=${service.CADENCR_RUST_PORT ?? "<unset>"} but ` +
        `${DESKTOP_ENV} VITE_API_URL=${desktop.VITE_API_URL ?? "<unset>"}`,
    );
  }
  return problems;
}

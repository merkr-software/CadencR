// Shared, side-effect-light helpers for the two dev `.env` files, used by
// scripts/setup-dev.mjs, scripts/doctor.mjs and scripts/configure-worktree-dev.mts.
import { randomBytes } from "node:crypto";
import {
  constants,
  existsSync,
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
} from "node:fs";
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
  const fd = openPrivateEnv(filePath, false);
  try {
    return parseEnv(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}

/** Missing, blank, or still the `.env.example` placeholder (`replace-with-…`). */
export function isPlaceholderToken(value) {
  return value === undefined || value.trim() === "" || value.trim().startsWith("replace-with");
}

export function generateToken() {
  return randomBytes(32).toString("hex");
}

/**
 * Serialize a value so every `.env` reader here (Node's parseEnv, Vite's
 * dotenv, the service's dotenvy) reads it back unchanged: plain values as-is,
 * others single-quoted (literal everywhere), and values with an apostrophe
 * double-quoted unless they hold what double quotes would expand.
 */
export function formatEnvValue(value) {
  const text = String(value);
  if (/^[\w@%+=:,./~-]*$/.test(text)) return text;
  if (!/['\r\n]/.test(text)) return `'${text}'`;
  if (!/["$\\\r\n]/.test(text)) return `"${text}"`;
  throw new Error(`cannot write ${JSON.stringify(text)} to a .env file unambiguously`);
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
    const line = `${key}=${formatEnvValue(value)}`;
    const pattern = new RegExp(`^${key}=.*$`, "m");
    // A replacer function keeps `$` in a token from being read as a pattern.
    next = pattern.test(next)
      ? next.replace(pattern, () => line)
      : `${next.replace(/\s*$/, "")}\n${line}\n`;
  }
  return next;
}

/** Open without following a final symlink and tighten before reading/writing. */
function openPrivateEnv(filePath, create) {
  const fd = openSync(
    filePath,
    constants.O_RDWR |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0) |
      (create ? constants.O_CREAT : 0),
    0o600,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error(`Not a regular private env file: ${filePath}`);
    if (process.platform !== "win32" && (stat.mode & 0o7777) !== 0o600) fchmodSync(fd, 0o600);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** Write at 0600 from creation; preserve existing permissions before writing. */
export function writePrivateEnv(filePath, content) {
  const fd = openPrivateEnv(filePath, true);
  try {
    // Truncate through the checked descriptor only after tightening its mode.
    writeFileSync(fd, content);
    // writeFileSync(fd) does not truncate existing files.
    const bytes = Buffer.byteLength(content);
    ftruncateSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

/** Read-modify-write values while retaining comments and unrelated keys. */
export function updateEnvFile(root, relativePath, values) {
  const filePath = join(root, relativePath);
  const fd = openPrivateEnv(filePath, false);
  let text;
  try {
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  writePrivateEnv(filePath, setEnvValues(text, values));
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

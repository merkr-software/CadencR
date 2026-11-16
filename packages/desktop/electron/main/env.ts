import fs from "node:fs";
import path from "node:path";
import { parse } from "dotenv";

const DOTENV_DISPLAY_PATH = "packages/desktop/.env";
const DOTENV_EXAMPLE_PATH = "packages/desktop/.env.example";
const REQUIRED_DEV_ENV_KEYS = ["VITE_FRONTEND_PORT", "VITE_API_URL", "VITE_API_TOKEN"] as const;

export function packageRoot(): string {
  return process.cwd();
}

function dotenvPath(root: string): string {
  return path.join(root, ".env");
}

export function loadDevEnv(root: string = packageRoot()): string {
  const filePath = dotenvPath(root);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Missing required dev env file \`${DOTENV_DISPLAY_PATH}\`. Copy ` +
        `\`${DOTENV_EXAMPLE_PATH}\` to \`${DOTENV_DISPLAY_PATH}\`.`,
    );
  }

  const values = parse(readPrivateEnv(filePath));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  validateRequiredDevEnvKeys(values);
  return filePath;
}

/** Tighten the opened inode before reading, without following or replacing a secret file. */
function readPrivateEnv(filePath: string): string {
  if (fs.lstatSync(filePath).isSymbolicLink())
    throw new Error("Development env must not be a symbolic link.");
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1)
      throw new Error("Development env must be a regular, unshared file.");
    if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
      fs.fchmodSync(descriptor, 0o600);
    }
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateRequiredDevEnvKeys(values: Record<string, string>): void {
  const missing = REQUIRED_DEV_ENV_KEYS.filter((key) => {
    const value = process.env[key] ?? values[key];
    return !value || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new Error(`Missing required keys in \`${DOTENV_DISPLAY_PATH}\`: ${missing.join(", ")}.`);
  }
}

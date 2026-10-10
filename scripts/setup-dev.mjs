// First-run setup for a main checkout: `pnpm setup:dev [--fix-token] [--precompile]`.
//
// Idempotent. Copies each missing `.env` from its `.env.example` (never
// overwrites), gives both files one shared random token, and installs the
// Electron binary. It never creates, copies, or deletes a database: the service
// creates its dev database on first launch.
//
// Linked worktrees are refused on purpose: `pnpm dev:configure-worktree` is the
// right tool there. It copies the main checkout's `.env` files and assigns
// ports that do not collide with other worktrees, which this script cannot do
// without either clobbering existing files or copying the dev database.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_ENV,
  SERVICE_ENV,
  generateToken,
  isPlaceholderToken,
  readEnvFile,
  updateEnvFile,
} from "./dev-env.mjs";
import { gitCheckout } from "./git-worktrees.mts";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));

/** Copy `.env.example` to `.env` where missing. Returns the created paths. */
export function copyMissingEnvFiles(root) {
  const created = [];
  for (const envPath of [SERVICE_ENV, DESKTOP_ENV]) {
    const target = join(root, envPath);
    if (existsSync(target)) continue;
    const example = `${target}.example`;
    if (!existsSync(example)) throw new Error(`Missing ${envPath}.example`);
    copyFileSync(example, target);
    created.push(envPath);
  }
  return created;
}

const toService = (value) => ({ file: SERVICE_ENV, key: "CADENCR_AUTH_TOKEN", value });
const toDesktop = (value) => ({ file: DESKTOP_ENV, key: "VITE_API_TOKEN", value });

/**
 * Decide how to reconcile CADENCR_AUTH_TOKEN and VITE_API_TOKEN: the `.env`
 * writes to make, plus a one-line status. `ok: false` means the tokens differ
 * and are left alone.
 */
export function planTokenSync(serviceToken, desktopToken, options = {}) {
  const { fixToken = false, newToken = generateToken } = options;
  const servicePlaceholder = isPlaceholderToken(serviceToken);
  if (servicePlaceholder && isPlaceholderToken(desktopToken)) {
    const token = newToken();
    const message = "generated one dev token for both .env files";
    return { ok: true, writes: [toService(token), toDesktop(token)], message };
  }
  if (servicePlaceholder) {
    const message = `copied VITE_API_TOKEN into ${SERVICE_ENV}`;
    return { ok: true, writes: [toService(desktopToken)], message };
  }
  if (serviceToken === desktopToken)
    return { ok: true, writes: [], message: "tokens already match" };
  // The service token is what the backend enforces; the desktop follows it.
  if (isPlaceholderToken(desktopToken) || fixToken) {
    const message = `copied CADENCR_AUTH_TOKEN into ${DESKTOP_ENV}`;
    return { ok: true, writes: [toDesktop(serviceToken)], message };
  }
  return {
    ok: false,
    writes: [],
    message:
      `CADENCR_AUTH_TOKEN (${SERVICE_ENV}) and VITE_API_TOKEN (${DESKTOP_ENV}) differ, ` +
      "so every request would 401. Left unchanged; rerun with --fix-token to copy the " +
      "service token into the desktop file.",
  };
}

/** Apply `planTokenSync` to the checkout's two `.env` files. */
export function syncTokens(root, options = {}) {
  const serviceToken = readEnvFile(root, SERVICE_ENV)?.CADENCR_AUTH_TOKEN;
  const desktopToken = readEnvFile(root, DESKTOP_ENV)?.VITE_API_TOKEN;
  const { ok, writes, message } = planTokenSync(serviceToken, desktopToken, options);
  for (const { file, key, value } of writes) updateEnvFile(root, file, { [key]: value });
  return { ok, message };
}

function run(label, command, args) {
  console.log(`\n==> ${label}: ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${label} failed (exit ${result.status ?? result.signal})`);
}

function main(argv) {
  if (gitCheckout(repoRoot).linkedWorktree) {
    console.error(
      "This checkout is a linked Git worktree. Run `pnpm dev:configure-worktree` instead:\n" +
        "it copies the main checkout's .env files (tokens included) and assigns ports that\n" +
        "do not collide with the main checkout or other worktrees. Then run `pnpm doctor`.",
    );
    return 1;
  }
  const created = copyMissingEnvFiles(repoRoot);
  for (const envPath of created) console.log(`created ${envPath} from its .env.example`);
  if (created.length === 0) console.log("both .env files exist; left as they are");
  const tokens = syncTokens(repoRoot, { fixToken: argv.includes("--fix-token") });
  console.log(tokens.ok ? tokens.message : `warning: ${tokens.message}`);

  run("Electron binary", "pnpm", ["--filter", "@cadencr/desktop", "run", "ensure:electron"]);
  if (argv.includes("--precompile")) run("Rust dev targets", "pnpm", ["run", "dev:precompile"]);

  console.log(
    "\nSetup done. Check the environment with `pnpm doctor`, then start with `pnpm dev`.",
  );
  return tokens.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`setup:dev: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

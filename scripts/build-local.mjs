import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validatedBuildEnv } from "./validate-marketplace-build-env.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repository = "merkr-software/CadencR";
const buildVariable = /^CADENCR_((MANAGED|REGISTRY)_[A-Z0-9_]+|SENTRY_DSN|POSTHOG_(KEY|HOST))$/;
const telemetryVariables = ["CADENCR_SENTRY_DSN", "CADENCR_POSTHOG_KEY", "CADENCR_POSTHOG_HOST"];

function withoutBuildConfiguration(baseEnv) {
  const env = { ...baseEnv };
  // An old shell export must neither fill a missing pin nor activate fallback builds.
  for (const name of Object.keys(env)) if (buildVariable.test(name)) delete env[name];
  return env;
}

function telemetryUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTPS URL.`);
  }
  if (url.protocol !== "https:" || !url.hostname || url.password || /[?#]/.test(url.href)) {
    throw new Error(`${name} must use HTTPS without a password, query or fragment.`);
  }
  return url;
}

function validateTelemetry(env) {
  const sentry = telemetryUrl(env.CADENCR_SENTRY_DSN, "CADENCR_SENTRY_DSN");
  if (
    !/^https:\/\/[A-Za-z0-9._-]{1,128}@/i.test(env.CADENCR_SENTRY_DSN) ||
    !/\/[0-9]+\/*$/.test(sentry.pathname)
  ) {
    throw new Error("CADENCR_SENTRY_DSN requires a public key and a numeric project ID.");
  }
  const posthog = telemetryUrl(env.CADENCR_POSTHOG_HOST, "CADENCR_POSTHOG_HOST");
  if (posthog.username || posthog.pathname !== "/") {
    throw new Error("CADENCR_POSTHOG_HOST must be an HTTPS origin without credentials or a path.");
  }
}

export function localBuildEnv(variables, baseEnv) {
  if (
    !Array.isArray(variables) ||
    variables.some((entry) => typeof entry?.name !== "string" || typeof entry?.value !== "string")
  ) {
    throw new Error("GitHub returned an invalid repository variable list.");
  }

  const env = withoutBuildConfiguration(baseEnv);
  const selected = variables.filter(({ name }) => buildVariable.test(name));
  if (selected.every(({ value }) => !value.trim())) return validatedBuildEnv(env);
  for (const { name, value } of selected) env[name] = value;

  const missing = telemetryVariables.filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`Missing GitHub build variables: ${missing.join(", ")}`);
  for (const name of telemetryVariables) {
    if (env[name].trim() !== env[name]) throw new Error(`${name} contains surrounding whitespace.`);
  }
  validateTelemetry(env);
  return validatedBuildEnv(env, { requireCatalog: true });
}

function unconfiguredBuild(reason) {
  console.warn(`${reason} Managed marketplace and telemetry are disabled for this build.`);
  return { env: validatedBuildEnv(withoutBuildConfiguration(process.env)), configured: false };
}

function fetchBuildEnv() {
  console.log(`Loading public build configuration from ${repository}…`);
  const result = spawnSync(
    "gh",
    ["variable", "list", "--repo", repository, "--json", "name,value"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  if (result.error?.code === "ENOENT") {
    return unconfiguredBuild("GitHub CLI (gh) is not installed.");
  }
  if (result.error || result.status !== 0) {
    return unconfiguredBuild("GitHub build variables are unavailable (connection or access).");
  }
  let variables;
  try {
    variables = JSON.parse(result.stdout);
  } catch {
    throw new Error("GitHub returned invalid JSON for repository variables.");
  }
  const env = localBuildEnv(variables, process.env);
  if (!env.CADENCR_SENTRY_DSN)
    return unconfiguredBuild("No GitHub build variables are configured.");
  return { env, configured: true };
}

function main() {
  const args = process.argv.slice(2);
  const linux = args[0] === "--linux";
  if (linux) args.shift();
  const checkOnly = args[0] === "--check-config";
  if (checkOnly && args.length !== 1) {
    throw new Error("--check-config cannot be combined with build arguments.");
  }
  const { env, configured } = fetchBuildEnv();
  const description = configured
    ? "Marketplace and telemetry build configuration is valid."
    : "Managed marketplace and telemetry are disabled.";
  if (checkOnly) {
    console.log(`${description} No build started.`);
    return;
  }
  console.log(`${description} Building locally…`);
  const command = linux
    ? ["pnpm", "--filter", "@cadencr/desktop", "build:local:linux"]
    : ["turbo", "run", "build:local", "--filter=@cadencr/desktop"];
  const result = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts/cargo-env.mjs"), ...command, ...args],
    {
      cwd: repoRoot,
      env,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`Local build failed: ${error.message}`);
    process.exitCode = 1;
  }
}

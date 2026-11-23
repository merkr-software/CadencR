import path from "node:path";

export interface DevProfile {
  /** Where the dev app should point `userData` — and what the instance lock is keyed on. */
  userDataPath: string;
  /** Path of the `.env` that was loaded, or `null` when loading failed. */
  envPath: string | null;
  /** Load failure, for the caller to raise once it can be shown to the user. */
  envError: unknown;
}

/**
 * Resolves the dev profile directory, loading `.env` FIRST.
 *
 * The order is the whole point. `CADENCR_DEV_USER_DATA_SUFFIX` is what keeps
 * each worktree on its own profile, `scripts/configure-worktree-dev.mts` writes
 * it into `packages/desktop/.env`, and nothing else puts it in the environment
 * — so reading the suffix before loading that file silently yields the shared
 * `desktop-dev` profile for every checkout. Since Electron's single-instance
 * lock is keyed on `userData`, the second worktree to start then dies with
 * "second instance — exiting" even though its ports are unique.
 *
 * A `.env` failure is returned, not thrown: this runs at module scope, before
 * `app.whenReady()` and so outside the startup-recovery `catch` — raising here
 * would take the app down with nothing on screen. `bootstrap()` re-raises it
 * where it can at least be reported.
 */
export function resolveDevProfile(
  appDataPath: string,
  loadEnv: () => string,
  env: Record<string, string | undefined> = process.env,
): DevProfile {
  let envPath: string | null = null;
  let envError: unknown = null;
  try {
    envPath = loadEnv();
  } catch (error) {
    envError = error;
  }
  return {
    userDataPath:
      explicitUserDataDir(env.CADENCR_DEV_USER_DATA_DIR) ??
      devUserDataPath(appDataPath, env.CADENCR_DEV_USER_DATA_SUFFIX),
    envPath,
    envError,
  };
}

/**
 * `CADENCR_DEV_USER_DATA_DIR` puts the whole profile in a given folder: an
 * isolated QA run (`pnpm qa:up`) keeps it inside its run directory so `qa:down`
 * removes it with the run. Only an absolute path counts, so a stray relative
 * value can never land a profile inside the checkout.
 */
function explicitUserDataDir(value: string | undefined): string | null {
  const dir = value?.trim();
  return dir && path.isAbsolute(dir) ? dir : null;
}

export function devUserDataPath(appDataPath: string, suffix: string | undefined): string {
  const safeSuffix = suffix ? sanitizeSuffix(suffix) : "";
  const profileName = safeSuffix ? `desktop-dev-${safeSuffix}` : "desktop-dev";
  return path.join(appDataPath, "@cadencr", profileName);
}

function sanitizeSuffix(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Cadencr's per-user data/config/cache locations, mirroring the Rust
// helper in `packages/service/src/shared/app_paths.rs`. The two MUST agree:
// the Electron main process picks the database path here and passes it to
// the spawned sidecar via `--db-path`, so any drift between the two helpers
// means the sidecar writes one file and the app reads another.
//
// Linux follows the XDG Base Directory spec; macOS keeps the legacy
// `~/.cadencr/...` layout so existing installs and the `db` skill keep
// working. We deliberately do NOT use `app.getPath("userData")` — its Linux
// default is `~/.config/Cadencr`, which would collide with what we want
// for config-only data and would be wrong for the database.

import os from "node:os";
import path from "node:path";

const APP_DIRNAME = "cadencr";
const MACOS_LEGACY_DIRNAME = ".cadencr";

/// Test-only overrides. Production callers omit `overrides` entirely.
export interface AppPathsOverrides {
  platform?: NodeJS.Platform;
  homedir?: string;
  env?: NodeJS.ProcessEnv;
}

type Kind = "data" | "config" | "cache";

const XDG_VAR: Record<Kind, string> = {
  data: "XDG_DATA_HOME",
  config: "XDG_CONFIG_HOME",
  cache: "XDG_CACHE_HOME",
};

const XDG_FALLBACK: Record<Kind, string> = {
  data: path.join(".local", "share"),
  config: ".config",
  cache: ".cache",
};

function resolveRoot(kind: Kind, overrides: AppPathsOverrides = {}): string {
  const platform = overrides.platform ?? process.platform;
  const homedir = overrides.homedir ?? os.homedir();
  if (platform === "darwin") return path.join(homedir, MACOS_LEGACY_DIRNAME);
  const env = overrides.env ?? process.env;
  const xdgValue = env[XDG_VAR[kind]];
  // Per the XDG spec, non-absolute values must be ignored.
  const base =
    xdgValue && path.isAbsolute(xdgValue) ? xdgValue : path.join(homedir, XDG_FALLBACK[kind]);
  return path.join(base, APP_DIRNAME);
}

export function resolveDataDir(overrides?: AppPathsOverrides): string {
  return resolveRoot("data", overrides);
}

export function resolveConfigDir(overrides?: AppPathsOverrides): string {
  return resolveRoot("config", overrides);
}

export function resolveCacheDir(overrides?: AppPathsOverrides): string {
  return resolveRoot("cache", overrides);
}

export function resolveDatabasePath(overrides?: AppPathsOverrides): string {
  return path.join(resolveDataDir(overrides), "database", "cadencr.db");
}

export function resolveWorktreesDir(overrides?: AppPathsOverrides): string {
  return path.join(resolveDataDir(overrides), "worktrees");
}

export function resolveLogsDir(overrides?: AppPathsOverrides): string {
  return path.join(resolveCacheDir(overrides), "logs");
}

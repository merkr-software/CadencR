import path from "node:path";

/** Set by the AppImage runtime for its own process tree. */
const APPIMAGE_RUNTIME_VARS = ["APPIMAGE", "APPDIR", "OWD", "ARGV0"];

/** Search-path lists the AppImage runtime may prefix with its mount point. */
const SEARCH_PATH_VARS = [
  "PATH",
  "LD_LIBRARY_PATH",
  "XDG_DATA_DIRS",
  "GSETTINGS_SCHEMA_DIR",
  "GTK_PATH",
  "QT_PLUGIN_PATH",
  "PYTHONPATH",
  "PERLLIB",
  "GST_PLUGIN_SYSTEM_PATH",
  "GST_PLUGIN_SYSTEM_PATH_1_0",
];

function withoutMountEntries(value: string, mountPoint: string): string {
  return value
    .split(path.delimiter)
    .filter((entry) => entry !== mountPoint && !entry.startsWith(`${mountPoint}/`))
    .join(path.delimiter);
}

/**
 * The environment the service sidecar — and through it every agent CLI, PTY
 * and git process — inherits. On Linux, Electron and the AppImage runtime add
 * variables meant only for Cadencr's own process: the read-only AppImage mount
 * on library/search paths (which would make user tools load Cadencr's bundled
 * libraries) and Electron's replacement desktop name. Elsewhere the environment
 * passes through unchanged.
 */
export function childProcessEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  if (platform !== "linux") return next;

  const mountPoint = env.APPDIR;
  if (mountPoint) {
    for (const key of SEARCH_PATH_VARS) {
      const value = next[key];
      if (value === undefined) continue;
      const cleaned = withoutMountEntries(value, mountPoint);
      if (cleaned) next[key] = cleaned;
      else delete next[key];
    }
  }
  for (const key of APPIMAGE_RUNTIME_VARS) delete next[key];

  // Electron swaps XDG_CURRENT_DESKTOP on some desktops and keeps the user's
  // value here; children (xdg-open, agents) should see the real desktop.
  if (env.ORIGINAL_XDG_CURRENT_DESKTOP) {
    next.XDG_CURRENT_DESKTOP = env.ORIGINAL_XDG_CURRENT_DESKTOP;
    delete next.ORIGINAL_XDG_CURRENT_DESKTOP;
  }
  delete next.CHROME_DESKTOP;
  return next;
}

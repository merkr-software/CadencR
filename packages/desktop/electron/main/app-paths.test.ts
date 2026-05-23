import { describe, expect, it } from "vitest";
import type { AppPathsOverrides } from "./app-paths";
import {
  resolveCacheDir,
  resolveConfigDir,
  resolveDatabasePath,
  resolveDataDir,
  resolveLogsDir,
  resolveWorktreesDir,
} from "./app-paths";

function linux(env: NodeJS.ProcessEnv = {}): AppPathsOverrides {
  return { platform: "linux", homedir: "/home/u", env };
}

function macos(env: NodeJS.ProcessEnv = {}): AppPathsOverrides {
  return { platform: "darwin", homedir: "/Users/u", env };
}

describe("app-paths on macOS", () => {
  it("returns the legacy ~/.cadencr root for data, config, and cache", () => {
    expect(resolveDataDir(macos())).toBe("/Users/u/.cadencr");
    expect(resolveConfigDir(macos())).toBe("/Users/u/.cadencr");
    expect(resolveCacheDir(macos())).toBe("/Users/u/.cadencr");
  });

  it("places derived paths under ~/.cadencr", () => {
    expect(resolveDatabasePath(macos())).toBe("/Users/u/.cadencr/database/cadencr.db");
    expect(resolveWorktreesDir(macos())).toBe("/Users/u/.cadencr/worktrees");
    expect(resolveLogsDir(macos())).toBe("/Users/u/.cadencr/logs");
  });

  it("ignores XDG env vars on macOS", () => {
    expect(resolveDataDir(macos({ XDG_DATA_HOME: "/should/be/ignored" }))).toBe(
      "/Users/u/.cadencr",
    );
  });
});

describe("app-paths on Linux", () => {
  it("falls back to ~/.local/share, ~/.config, ~/.cache when XDG is unset", () => {
    expect(resolveDataDir(linux())).toBe("/home/u/.local/share/cadencr");
    expect(resolveConfigDir(linux())).toBe("/home/u/.config/cadencr");
    expect(resolveCacheDir(linux())).toBe("/home/u/.cache/cadencr");
  });

  it("honours XDG_DATA_HOME / XDG_CONFIG_HOME / XDG_CACHE_HOME when absolute", () => {
    const env = linux({
      XDG_DATA_HOME: "/tmp/xdg-data",
      XDG_CONFIG_HOME: "/tmp/xdg-config",
      XDG_CACHE_HOME: "/tmp/xdg-cache",
    });
    expect(resolveDataDir(env)).toBe("/tmp/xdg-data/cadencr");
    expect(resolveConfigDir(env)).toBe("/tmp/xdg-config/cadencr");
    expect(resolveCacheDir(env)).toBe("/tmp/xdg-cache/cadencr");
  });

  it("ignores non-absolute XDG values per the spec", () => {
    expect(resolveDataDir(linux({ XDG_DATA_HOME: "relative/path" }))).toBe(
      "/home/u/.local/share/cadencr",
    );
  });

  it("derives database/worktrees/logs paths from the resolved roots", () => {
    const env = linux({ XDG_DATA_HOME: "/tmp/xdg" });
    expect(resolveDatabasePath(env)).toBe("/tmp/xdg/cadencr/database/cadencr.db");
    expect(resolveWorktreesDir(env)).toBe("/tmp/xdg/cadencr/worktrees");
    expect(resolveLogsDir(linux())).toBe("/home/u/.cache/cadencr/logs");
  });
});

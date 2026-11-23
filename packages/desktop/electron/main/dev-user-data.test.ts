import path from "node:path";
import { describe, expect, it } from "vitest";
import { devUserDataPath, resolveDevProfile } from "./dev-user-data";

describe("devUserDataPath", () => {
  it("uses the default dev profile when no QA suffix is provided", () => {
    expect(devUserDataPath("/Users/example/AppData", undefined)).toBe(
      path.join("/Users/example/AppData", "@cadencr", "desktop-dev"),
    );
  });

  it("sanitizes an optional suffix so parallel QA instances get separate locks", () => {
    expect(devUserDataPath("/Users/example/AppData", "browser qa!")).toBe(
      path.join("/Users/example/AppData", "@cadencr", "desktop-dev-browser-qa"),
    );
  });
});

describe("resolveDevProfile", () => {
  it("loads the env file before reading the suffix", () => {
    // The regression: reading the suffix first resolved every worktree to the
    // shared `desktop-dev` profile, so the second one to launch lost the
    // single-instance lock and exited even with its own ports.
    const env: Record<string, string | undefined> = {};
    const loadEnv = () => {
      env.CADENCR_DEV_USER_DATA_SUFFIX = "feature-some-branch-a1b2";
      return "/repo/packages/desktop/.env";
    };

    const profile = resolveDevProfile("/Users/example/AppData", loadEnv, env);

    expect(profile.userDataPath).toBe(
      path.join("/Users/example/AppData", "@cadencr", "desktop-dev-feature-some-branch-a1b2"),
    );
    expect(profile.envPath).toBe("/repo/packages/desktop/.env");
    expect(profile.envError).toBeNull();
  });

  it("puts the whole profile in an absolute CADENCR_DEV_USER_DATA_DIR", () => {
    const env = {
      CADENCR_DEV_USER_DATA_DIR: "/tmp/qa-run/electron-profile",
      CADENCR_DEV_USER_DATA_SUFFIX: "ignored",
    };

    const profile = resolveDevProfile("/Users/example/AppData", () => "/repo/.env", env);

    expect(profile.userDataPath).toBe("/tmp/qa-run/electron-profile");
  });

  it("ignores a relative CADENCR_DEV_USER_DATA_DIR", () => {
    const env = { CADENCR_DEV_USER_DATA_DIR: "qa-profile" };

    const profile = resolveDevProfile("/Users/example/AppData", () => "/repo/.env", env);

    expect(profile.userDataPath).toBe(
      path.join("/Users/example/AppData", "@cadencr", "desktop-dev"),
    );
  });

  it("returns a load failure instead of throwing, so the splash can report it", () => {
    const failure = new Error("Missing required dev env file");
    const loadEnv = () => {
      throw failure;
    };

    const profile = resolveDevProfile("/Users/example/AppData", loadEnv, {});

    expect(profile.envError).toBe(failure);
    expect(profile.envPath).toBeNull();
    expect(profile.userDataPath).toBe(
      path.join("/Users/example/AppData", "@cadencr", "desktop-dev"),
    );
  });
});

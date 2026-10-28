import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeStartupFailure,
  ensureLinuxSidecarExecutable,
  parsePhaseLine,
  productionDbPath,
  rethrowAfterCleanup,
  resolveSettingsDir,
  serviceArgs,
  serviceEnv,
  waitForDevSidecar,
} from "./sidecar";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("production database path", () => {
  it("uses the standard production path even when a development path is inherited", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cadencr-production-path-"));
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.stubEnv("CADENCR_DB_PATH", path.join(home, "development.db"));
    vi.stubEnv("XDG_DATA_HOME", "");

    const dbPath = productionDbPath();

    // macOS keeps ~/.cadencr; Linux follows XDG (app-paths.test.ts covers both).
    const dataRoot =
      process.platform === "darwin"
        ? path.join(home, ".cadencr")
        : path.join(home, ".local", "share", "cadencr");
    expect(dbPath).toBe(path.join(dataRoot, "database", "cadencr.db"));
    expect(fs.existsSync(dbPath)).toBe(false);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.dirname(dbPath)).mode & 0o777).toBe(0o700);
    }
  });
});

describe("development sidecar startup", () => {
  it("waits for authenticated health before allowing startup API calls", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ service: "cadencr" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const updates: string[] = [];
    const handle = {
      baseUrl: "http://127.0.0.1:5005",
      authToken: "dev-token",
      stop: () => Promise.resolve(),
      setShutdownIntent: () => Promise.resolve(),
    };

    const startup = waitForDevSidecar(handle, (update) => updates.push(update.phase));
    await vi.advanceTimersByTimeAsync(5_000);
    await startup;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:5005/api/health",
      expect.objectContaining({ headers: { "x-cadencr-token": "dev-token" } }),
    );
    expect(updates).toEqual(["waiting_for_service", "loading_app"]);
  });

  it("rejects a missing development auth token before polling", async () => {
    await expect(
      waitForDevSidecar({
        baseUrl: "http://127.0.0.1:5005",
        authToken: null,
        stop: () => Promise.resolve(),
        setShutdownIntent: () => Promise.resolve(),
      }),
    ).rejects.toThrow("development service auth token is missing");
  });
});

describe("sidecar process arguments", () => {
  it("does not expose the auth token on argv", () => {
    const args = serviceArgs("/tmp/cadencr.db");
    const settingsDir = resolveSettingsDir("/tmp/cadencr.db");

    expect(args).toEqual([
      "--db-path",
      "/tmp/cadencr.db",
      "--settings-dir",
      settingsDir,
      "--port",
      "5004",
    ]);
    expect(args).not.toContain("--auth-token");
  });

  it("passes browser bridge settings through environment only", () => {
    const env = serviceEnv("auth", {
      url: "http://127.0.0.1:1234/browser-bridge",
      token: "bridge",
    });

    expect(env.CADENCR_AUTH_TOKEN).toBe("auth");
    expect(env.CADENCR_BROWSER_BRIDGE_URL).toBe("http://127.0.0.1:1234/browser-bridge");
    expect(env.CADENCR_BROWSER_BRIDGE_TOKEN).toBe("bridge");
    expect(serviceArgs("/tmp/cadencr.db")).not.toContain("bridge");
  });

  it("appends --app-version when provided", () => {
    const args = serviceArgs("/tmp/cadencr.db", "1.2.3");
    const settingsDir = resolveSettingsDir("/tmp/cadencr.db");

    expect(args).toEqual([
      "--db-path",
      "/tmp/cadencr.db",
      "--settings-dir",
      settingsDir,
      "--port",
      "5004",
      "--app-version",
      "1.2.3",
    ]);
  });

  it("appends --renderer-dir when provided, and omits it otherwise", () => {
    const settingsDir = resolveSettingsDir("/tmp/cadencr.db");
    expect(serviceArgs("/tmp/cadencr.db", undefined, "/res/renderer")).toEqual([
      "--db-path",
      "/tmp/cadencr.db",
      "--settings-dir",
      settingsDir,
      "--port",
      "5004",
      "--renderer-dir",
      "/res/renderer",
    ]);
    expect(serviceArgs("/tmp/cadencr.db", undefined, null)).not.toContain("--renderer-dir");
  });

  it("uses XDG config for Linux settings and preserves the legacy macOS layout", () => {
    expect(
      resolveSettingsDir(
        "/home/u/.local/share/cadencr/database/cadencr.db",
        "linux",
        "/home/u/.config/cadencr",
      ),
    ).toBe("/home/u/.config/cadencr/settings");
    expect(resolveSettingsDir("/Users/u/.cadencr/database/cadencr.db", "darwin")).toBe(
      "/Users/u/.cadencr/settings",
    );
  });
});

describe("parsePhaseLine", () => {
  it("recognizes backing_up with a path detail", () => {
    expect(parsePhaseLine("CADENCR_PHASE backing_up /home/u/.cadencr/database/foo.db")).toEqual({
      phase: "backing_up",
      detail: "/home/u/.cadencr/database/foo.db",
    });
  });

  it("recognizes migrating with no detail", () => {
    expect(parsePhaseLine("CADENCR_PHASE migrating")).toEqual({
      phase: "migrating",
      detail: undefined,
    });
  });

  it("recognizes startup database compaction", () => {
    expect(parsePhaseLine("CADENCR_PHASE compacting_database")).toEqual({
      phase: "compacting_database",
      detail: undefined,
    });
  });

  it("recognizes the initial lossless storage optimization", () => {
    expect(parsePhaseLine("CADENCR_PHASE optimizing_storage Moving verified duplicates")).toEqual({
      phase: "optimizing_storage",
      detail: "Moving verified duplicates",
    });
  });

  it("recognizes the one-time usage history import", () => {
    expect(parsePhaseLine("CADENCR_PHASE importing_usage")).toEqual({
      phase: "importing_usage",
      detail: undefined,
    });
  });

  it("recognizes backup_failed with reason", () => {
    expect(parsePhaseLine("CADENCR_PHASE backup_failed disk full")).toEqual({
      phase: "backup_failed",
      detail: "disk full",
    });
  });

  it("ignores unrelated log lines", () => {
    expect(parsePhaseLine("INFO cadencr_service: listening")).toBeNull();
    expect(parsePhaseLine("CADENCR_PHASE bogus")).toBeNull();
  });
});

describe("describeStartupFailure", () => {
  it("turns newer-database startup failures into explicit old-version fallback guidance", () => {
    const message = describeStartupFailure(
      "cadencr-service exited before passing health check at http://127.0.0.1:5004",
      [
        "Error: This database was updated by a newer version of Cadencr and cannot be opened safely by this older app. Install the latest Cadencr version, or restore a pre-migration backup before starting this older version.",
      ],
      1,
      null,
    );

    expect(message).toContain("updated by a newer version of Cadencr");
    expect(message).toContain("restore a pre-migration backup");
    expect(message).not.toContain("health check");
    expect(message).not.toContain("Open data folder");
  });
});

describe("failed startup cleanup", () => {
  it("awaits process cleanup before rethrowing the startup failure", async () => {
    const order: string[] = [];
    const failure = new Error("health timeout");

    await expect(
      rethrowAfterCleanup(failure, async () => {
        await Promise.resolve();
        order.push("stopped");
      }),
    ).rejects.toBe(failure);

    expect(order).toEqual(["stopped"]);
  });

  it("surfaces cleanup failure without hiding the startup failure", async () => {
    await expect(
      rethrowAfterCleanup(new Error("health timeout"), async () => {
        throw new Error("kill failed");
      }),
    ).rejects.toThrow(/health timeout[\s\S]*kill failed/);
  });
});

describe("ensureLinuxSidecarExecutable", () => {
  it("surfaces chmod failures on Linux when the binary is missing", () => {
    expect(() =>
      ensureLinuxSidecarExecutable("/definitely/missing/cadencr-service", "linux"),
    ).toThrow(/Failed to mark cadencr-service executable/);
  });

  it("does nothing on non-Linux platforms", () => {
    expect(() =>
      ensureLinuxSidecarExecutable("/definitely/missing/cadencr-service", "darwin"),
    ).not.toThrow();
  });

  it("is a no-op when the binary is already executable (e.g. deb/rpm installs)", () => {
    // dpkg/rpm install the sidecar into a root-owned /opt/Cadencr/...
    // directory where Cadencr (running as a normal user) can't chmod. The
    // helper must not throw when the bit is already set.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadencr-sidecar-"));
    const binary = path.join(dir, "cadencr-service");
    try {
      fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      expect(() => ensureLinuxSidecarExecutable(binary, "linux")).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

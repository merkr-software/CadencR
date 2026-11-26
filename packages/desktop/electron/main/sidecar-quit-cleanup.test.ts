import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSE_RESPONSE_TIMEOUT_MS, createCloseCoordinator } from "./close-coordinator";
import { VoluntaryQuit } from "./shutdown-intent";
import { preparePackagedQuit } from "./sidecar";
import { createExitedSidecarQuit } from "./sidecar-quit-cleanup";

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;
const execFile = vi.hoisted(() =>
  vi.fn<(binary: string, args: string[], options: unknown, callback: ExecCallback) => void>(),
);
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile,
}));

describe("quit after an attached sidecar has exited", () => {
  const epoch = "89b4a79d-a49e-43f8-b12a-9224a9cf9457";
  const binary = "/fixture/resources/cadencr-service";
  let root: string;
  let database: string;
  let quit: string;
  let armed: string;

  beforeEach(async () => {
    execFile.mockReset();
    root = await mkdtemp(path.join(os.tmpdir(), "cadencr-cold-quit-"));
    const recovery = path.join(root, "desktop-recovery");
    await mkdir(recovery);
    const databaseDirectory = path.join(root, "database");
    await mkdir(databaseDirectory);
    database = path.join(databaseDirectory, "fixture.db");
    await writeFile(database, "fixture");
    quit = path.join(recovery, `${epoch}.quit`);
    armed = path.join(recovery, `${epoch}.armed`);
    await writeFile(armed, "");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  });

  it.each(["responsive", "frozen", "frozen after acknowledging", "absent"] as const)(
    "keeps the %s quit pending until the installed binary confirms the drain",
    async (renderer) => {
      vi.useFakeTimers();
      const started = Promise.withResolvers<ExecCallback>();
      execFile.mockImplementation((_binary, _args, _options, callback) =>
        started.resolve(callback),
      );
      const exited = vi.fn();
      const quitAfterExit = createExitedSidecarQuit(binary, database, epoch);
      const voluntaryQuit = new VoluntaryQuit();
      const live = vi.fn();
      let attempt: Promise<void> | undefined;
      const coordinator = createCloseCoordinator({
        renderer: { canAnswer: () => renderer !== "absent", ask: () => true },
        finish: () => {
          attempt = voluntaryQuit.run(async () => {
            await preparePackagedQuit({ exited: true }, live, async () => {
              await quitAfterExit();
            });
            exited();
          });
          return attempt;
        },
        reportUnanswered: vi.fn(),
      });

      coordinator.request(true);
      if (renderer === "responsive") void coordinator.confirm(1);
      if (renderer === "frozen") vi.advanceTimersByTime(CLOSE_RESPONSE_TIMEOUT_MS);
      if (renderer === "frozen after acknowledging") {
        coordinator.acknowledge(1);
        coordinator.rendererLost();
      }
      const confirmDrain = await started.promise;

      expect((await lstat(quit)).isFile()).toBe(true);
      expect(live).not.toHaveBeenCalled();
      expect(execFile).toHaveBeenCalledExactlyOnceWith(
        binary,
        ["--internal-desktop-quit-cleanup", database, epoch],
        expect.objectContaining({ timeout: 45_000, killSignal: "SIGKILL" }),
        expect.any(Function),
      );
      expect(voluntaryQuit.inProgress).toBe(true);
      expect(exited).not.toHaveBeenCalled();
      confirmDrain(null, "", "");
      await attempt;
      expect(exited).toHaveBeenCalledOnce();
      expect(voluntaryQuit.inProgress).toBe(false);
    },
  );

  it.each([
    [new Error("ambiguous process ownership"), "ambiguous process ownership"],
    [
      Object.assign(new Error("cleanup expired"), { killed: true, signal: "SIGKILL" }),
      "The cleanup did not finish in time",
    ],
  ])("preserves the decision for retry after %s", async (error, detail) => {
    execFile.mockImplementationOnce((_binary, _args, _options, callback) =>
      callback(error, "", ""),
    );
    execFile.mockImplementationOnce((_binary, _args, _options, callback) => callback(null, "", ""));
    const quitAfterExit = createExitedSidecarQuit(binary, database, epoch);
    const voluntaryQuit = new VoluntaryQuit();
    const resumeBrowser = vi.fn();
    const exited = vi.fn();
    const attempt = () =>
      voluntaryQuit.run(async () => {
        await voluntaryQuit.prepare({
          service: {
            prepareQuit: async () => {
              await quitAfterExit();
            },
          },
          prepareBrowser: async () => {},
          resumeBrowser,
        });
        exited();
      });

    await expect(attempt()).rejects.toThrow(detail);
    expect(exited).not.toHaveBeenCalled();
    expect(resumeBrowser).toHaveBeenCalledOnce();
    expect((await lstat(quit)).isFile()).toBe(true);
    await attempt();
    expect(exited).toHaveBeenCalledOnce();
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("leaves the never-armed startup path free to quit without a cleanup process", async () => {
    await rm(armed);
    await writeFile(path.join(path.dirname(armed), `${epoch}.preparing`), "");
    await expect(createExitedSidecarQuit(binary, database, epoch)(true)).resolves.toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("asks the helper for exact-epoch proof when startup already consumed the attached slot", async () => {
    await rm(armed);
    execFile.mockImplementationOnce((_binary, _args, _options, callback) => callback(null, "", ""));

    await expect(createExitedSidecarQuit(binary, database, epoch)()).resolves.toBe(true);
    expect(execFile).toHaveBeenCalledExactlyOnceWith(
      binary,
      ["--internal-desktop-quit-cleanup", database, epoch],
      expect.any(Object),
      expect.any(Function),
    );
  });
});

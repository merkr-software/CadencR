import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preparePackagedQuit } from "./sidecar";
import { recordQuitAfterSidecarExit, sidecarQuitDirectory } from "./sidecar-quit-journal";

describe("packaged quit journal", () => {
  let directory: string;
  const epoch = "89b4a79d-a49e-43f8-b12a-9224a9cf9457";

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "cadencr-quit-test-"));
    await writeFile(path.join(directory, `${epoch}.armed`), "");
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("durably records the stop for a confirmed dead sidecar and can retry it", async () => {
    const live = vi.fn();
    const record = async () => {
      await recordQuitAfterSidecarExit(directory, epoch);
    };
    await preparePackagedQuit({ exited: true }, live, record);
    await expect(record()).resolves.toBeUndefined();
    expect(live).not.toHaveBeenCalled();
    expect(sidecarQuitDirectory(path.join(directory, "database", "cadencr.db"))).toBe(
      path.join(directory, "desktop-recovery"),
    );
  });

  it("leaves an unresponsive live service eligible to recover after crash alone", async () => {
    const record = vi.fn();
    const live = vi.fn().mockRejectedValue(new Error("timeout"));
    await expect(preparePackagedQuit({ exited: false }, live, record)).rejects.toThrow("timeout");
    expect(record).not.toHaveBeenCalled();
  });

  it("records the stop when exit is observed during a failing live request", async () => {
    const child = { exited: false };
    const live = async () => {
      child.exited = true;
      throw new Error("connection closed");
    };
    const record = async () => {
      await recordQuitAfterSidecarExit(directory, epoch);
    };
    await expect(preparePackagedQuit(child, live, record)).resolves.toBeUndefined();
  });

  it("checks the durable slot even when the sidecar died before attachment", async () => {
    await expect(recordQuitAfterSidecarExit(directory, "never-armed", true)).resolves.toBe(false);
    await expect(recordQuitAfterSidecarExit(directory, epoch, true)).resolves.toBe(true);
  });

  it("refuses an epoch already claimed by recovery or unrelated to the attached child", async () => {
    await rename(
      path.join(directory, `${epoch}.armed`),
      path.join(directory, `${epoch}.recovering`),
    );
    await expect(recordQuitAfterSidecarExit(directory, epoch)).rejects.toThrow(
      "already be recovering",
    );
    await expect(recordQuitAfterSidecarExit(directory, "another-epoch")).rejects.toThrow(
      "could not confirm",
    );
  });
});

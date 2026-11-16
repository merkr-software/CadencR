import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reserveBrowserDownloadPath } from "./browser-download-path";
import { BrowserDownloadRecord } from "./browser-download-record";
import { descriptorReleased } from "./test-descriptor";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("BrowserDownloadRecord", () => {
  it.each(["completed", "cancelled", "snapshot-error"] as const)(
    "closes the reservation descriptor after %s",
    async (scenario) => {
      const root = path.join(tmpdir(), `cadencr-download-record-${process.pid}-${roots.length}`);
      mkdirSync(root, { recursive: true });
      roots.push(root);
      const reservation = reserveBrowserDownloadPath(root, "report.txt");
      const descriptor = reservation.descriptor!;
      const item = downloadItem();
      const record = BrowserDownloadRecord.live(
        item,
        {
          id: "download-id",
          tabId: "tab-id",
          scopeId: 4,
          private: true,
          filename: "report.txt",
          destination: reservation.path,
        },
        reservation,
        async () => undefined,
        1_800_000_000_000,
      );
      if (scenario === "snapshot-error") {
        item.getReceivedBytes = () => {
          throw new Error("snapshot failed");
        };
      }
      await record.finalize(
        scenario === "completed" ? "completed" : "cancelled",
        1_800_000_000_100,
        () => undefined,
      );
      expect(reservation.descriptor).toBeNull();
      expect(descriptorReleased(descriptor, reservation)).toBe(true);
      if (scenario === "completed") expect(readFileSync(reservation.path)).toHaveLength(0);
      if (scenario === "snapshot-error") expect(record.public.error).toContain("snapshot failed");
    },
  );

  it("releases its lease and settles when state publication throws", async () => {
    const root = path.join(tmpdir(), `cadencr-download-record-${process.pid}-${roots.length}`);
    mkdirSync(root, { recursive: true });
    roots.push(root);
    const reservation = reserveBrowserDownloadPath(root, "report.txt");
    const release = vi.fn(async () => undefined);
    const item = downloadItem();
    const record = BrowserDownloadRecord.live(
      item,
      {
        id: "download-id",
        tabId: "tab-id",
        scopeId: 4,
        private: true,
        filename: "report.txt",
        destination: reservation.path,
      },
      reservation,
      release,
      1_800_000_000_000,
    );

    const result = record.finalize("cancelled", 1_800_000_000_100, () => {
      throw new Error("publication failed");
    });

    await expect(result).rejects.toThrow("publication failed");
    await expect(record.terminal).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
    expect(record.settled).toBe(true);
  });
});

function downloadItem(): Electron.DownloadItem {
  return {
    getTotalBytes: () => 100,
    getReceivedBytes: () => 50,
    getCurrentBytesPerSecond: () => 10,
    getStartTime: () => 1_700_000_000,
    canResume: () => false,
  } as Electron.DownloadItem;
}

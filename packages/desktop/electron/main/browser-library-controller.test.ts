import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserLibraryController } from "./browser-library-controller";
import { BrowserLibraryStore } from "./browser-library-store";
import { createBrowserProfile, type BrowserProfileMode } from "./browser-profiles";
import type { ManagedTab } from "./browser-tab-events";

const directories: string[] = [];
const pageUrl = "https://example.com/controller-qa";

async function fixture(mode: BrowserProfileMode = "persistent") {
  const directory = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "browser-policy-"));
  directories.push(directory);
  const store = new BrowserLibraryStore(path.join(directory, "library.json"));
  const legacyOrigins = path.join(directory, "browser-origins.json");
  await fs.writeFile(legacyOrigins, JSON.stringify({ origins: [{ origin: "https://a.test" }] }));
  const tab = {
    metadata: { id: "tab-1", scopeId: 7 },
    profile: createBrowserProfile(mode),
    webContents: { getURL: () => pageUrl, getTitle: () => "Initial" },
  } as unknown as ManagedTab;
  const reportError = vi.fn();
  const controller = new BrowserLibraryController(
    store,
    () => tab,
    reportError,
    () => fs.rm(legacyOrigins, { force: true }),
  );
  return { controller, store, legacyOrigins, tab, reportError };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

describe("BrowserLibraryController policy", () => {
  it.each(["fresh", "feature"] as const)("never persists %s tabs", async (mode) => {
    const { controller, store, tab, reportError } = await fixture(mode);
    const record = vi.spyOn(store, "recordHistoryNavigation");
    const title = vi.spyOn(store, "updateHistoryTitle");
    const bookmark = vi.spyOn(store, "setBookmark");
    vi.useFakeTimers();

    controller.recordNavigation(tab, pageUrl, "Initial");
    controller.updateTitle(tab, pageUrl, "Later");
    await vi.runAllTimersAsync();
    await expect(async () => controller.setBookmark(tab.metadata.id, true)).rejects.toThrow(
      "cannot be bookmarked",
    );
    expect(record).not.toHaveBeenCalled();
    expect(title).not.toHaveBeenCalled();
    expect(bookmark).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("coalesces rapid title changes without changing visit recency", async () => {
    const { controller, store, tab } = await fixture();
    const entry = await store.recordHistoryNavigation(pageUrl, "Initial");
    const record = vi.spyOn(store, "recordHistoryNavigation").mockResolvedValue(entry);
    const update = vi.spyOn(store, "updateHistoryTitle");
    vi.useFakeTimers();
    controller.recordNavigation(tab, pageUrl, "Initial");
    controller.updateTitle(tab, pageUrl, "Interim");
    controller.updateTitle(tab, pageUrl, "Final");
    await vi.advanceTimersByTimeAsync(199);
    expect(update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await update.mock.results[0]?.value;

    expect(record).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledExactlyOnceWith(pageUrl, "Final");
    expect((await store.query("")).history[0]).toMatchObject({
      title: "Final",
      visitedAt: entry.visitedAt,
    });
  });

  it.each(["clear", "delete"] as const)(
    "a pending title cannot undo history %s",
    async (action) => {
      const { controller, store, tab } = await fixture();
      const entry = await store.recordHistoryNavigation(pageUrl, "Initial");
      vi.spyOn(store, "recordHistoryNavigation").mockResolvedValue(entry);
      const update = vi.spyOn(store, "updateHistoryTitle");
      vi.useFakeTimers();
      controller.recordNavigation(tab, pageUrl, "Initial");
      controller.updateTitle(tab, pageUrl, "Late title");
      if (action === "clear") await controller.clearHistory();
      else await controller.removeHistoryEntry(entry.id);
      await vi.runAllTimersAsync();
      await update.mock.results[0]?.value;

      expect((await store.query("")).history).toEqual([]);
    },
  );

  it("forgets pending title work when its tab is destroyed", async () => {
    const { controller, store, tab } = await fixture();
    const entry = await store.recordHistoryNavigation(pageUrl, "Initial");
    vi.spyOn(store, "recordHistoryNavigation").mockResolvedValue(entry);
    const update = vi.spyOn(store, "updateHistoryTitle");
    vi.useFakeTimers();
    controller.recordNavigation(tab, pageUrl, "Initial");
    controller.updateTitle(tab, pageUrl, "Discarded");
    controller.forget(tab.metadata.id);
    await vi.runAllTimersAsync();

    expect(update).not.toHaveBeenCalled();
  });

  it("surfaces rejected background writes in the owning workspace", async () => {
    const { controller, store, tab, reportError } = await fixture();
    vi.spyOn(store, "recordHistoryNavigation").mockRejectedValue(new Error("disk full"));
    controller.recordNavigation(tab, pageUrl, "Initial");
    await Promise.resolve();

    expect(reportError).toHaveBeenCalledWith("Could not save Browser history: disk full", 7);
  });

  it("ignores unsupported page URLs without issuing a storage operation", async () => {
    const { controller, store, tab } = await fixture();
    const record = vi.spyOn(store, "recordHistoryNavigation");
    for (const url of ["about:blank", "file:///tmp/fixture.html", "not a URL"]) {
      controller.recordNavigation(tab, url, "Page");
    }
    expect(record).not.toHaveBeenCalled();
  });

  it("removes the legacy origin history along with the history", async () => {
    const { controller, legacyOrigins } = await fixture();

    await controller.clearHistory();

    await expect(fs.access(legacyOrigins)).rejects.toThrow();
  });
});

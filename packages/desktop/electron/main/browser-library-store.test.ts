import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserLibraryStore } from "./browser-library-store";
import type { BrowserLibraryChange } from "./browser-types";

const temporaryDirectories: string[] = [];

async function storeAt(
  now: () => number = () => 1_700_000_000_000,
  onChanged: (change: BrowserLibraryChange) => void = () => undefined,
): Promise<{
  filePath: string;
  store: BrowserLibraryStore;
}> {
  const directory = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "cadencr-browser-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "library.json");
  return { filePath, store: new BrowserLibraryStore(filePath, now, onChanged) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

describe("BrowserLibraryStore", () => {
  it("signals only successfully committed library changes", async () => {
    const onChanged = vi.fn();
    const { store } = await storeAt(undefined, onChanged);

    await store.clearHistory();
    await store.recordHistoryNavigation("https://example.com", "Example");
    await store.setBookmark("https://example.com", "Example", true);
    await store.setBookmark("https://example.com", "Example", true);

    expect(onChanged.mock.calls).toEqual([
      [{ kind: "history" }],
      [{ kind: "bookmark", url: "https://example.com/" }],
    ]);
  });

  it("persists sanitized full-page history and bookmarks across instances", async () => {
    const { filePath, store } = await storeAt();
    await store.recordHistoryNavigation("https://alice:secret@example.com/docs?q=one", "  Docs  ");
    await store.setBookmark("https://alice:secret@example.com/docs?q=one", "Docs", true);

    const restarted = new BrowserLibraryStore(filePath);
    const result = await restarted.query("docs");

    expect(result.history).toMatchObject([
      { url: "https://example.com/docs?q=one", title: "Docs" },
    ]);
    expect(result.bookmarks).toMatchObject([
      { url: "https://example.com/docs?q=one", title: "Docs" },
    ]);
  });

  it("upserts a URL and applies title-only updates without changing recency", async () => {
    let now = 1_700_000_000_000;
    const { store } = await storeAt(() => now);
    const first = await store.recordHistoryNavigation("https://example.com/a", "Old title");
    now += 1_000;
    const same = await store.recordHistoryNavigation("https://example.com/a", "Interim title");
    const titled = await store.updateHistoryTitle("https://example.com/a", "Final title");

    expect(same.id).toBe(first.id);
    expect(same.visitedAt).not.toBe(first.visitedAt);
    expect(titled).toMatchObject({ id: first.id, title: "Final title", visitedAt: same.visitedAt });
    expect((await store.query("example")).history).toHaveLength(1);
  });

  it("does not recreate deleted history from a late title event", async () => {
    const { store } = await storeAt();
    const entry = await store.recordHistoryNavigation(
      "https://example.com/private-looking",
      "Page",
    );
    await store.removeHistoryEntry(entry.id);

    expect(await store.updateHistoryTitle(entry.url, "Late title")).toBeNull();
    expect((await store.query("")).history).toEqual([]);
  });

  it("does not recreate cleared history from a late title event", async () => {
    const { store } = await storeAt();
    await store.recordHistoryNavigation("https://example.com/a", "Page A");
    await store.recordHistoryNavigation("https://example.com/b", "Page B");
    await store.clearHistory();

    expect(await store.updateHistoryTitle("https://example.com/b", "Late title")).toBeNull();
    expect((await store.query("")).history).toEqual([]);
  });

  it("keeps confirmed memory state when an atomic replace fails and continues its queue", async () => {
    const { store } = await storeAt();
    await store.recordHistoryNavigation("https://example.com/confirmed", "Confirmed");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk full"));

    await expect(
      store.recordHistoryNavigation("https://example.com/uncommitted", "Uncommitted"),
    ).rejects.toThrow("disk full");
    expect((await store.query("")).history.map((entry) => entry.title)).toEqual(["Confirmed"]);

    await store.recordHistoryNavigation("https://example.com/after", "After failure");
    expect((await store.query("")).history.map((entry) => entry.title)).toEqual([
      "After failure",
      "Confirmed",
    ]);
  });

  // 260 sequential atomic writes, each re-serializing a ~512 KiB library while
  // `bounded()` binary-searches the byte budget. The work is deterministic but
  // CPU-bound (~0.7s idle, >5s on a saturated runner), so it gets its own budget.
  it("bounds records and query results", { timeout: 30_000 }, async () => {
    const { filePath, store } = await storeAt();
    const longSegment = "x".repeat(1_800);
    for (let index = 0; index < 260; index += 1) {
      await store.recordHistoryNavigation(
        `https://example.com/${index}?value=${longSegment}`,
        `Entry ${index} ${"🙂".repeat(250)}`,
      );
    }

    expect((await store.query("", 10_000)).history).toHaveLength(20);
    expect((await store.query("entry 259", 8)).history[0]?.title).toMatch(/^Entry 259/);
    const persisted = await fs.readFile(filePath);
    expect(persisted.byteLength).toBeLessThanOrEqual(512 * 1024);
  });

  it("ranks a late prefix ahead of an earlier substring within the result limit", async () => {
    const { store } = await storeAt();
    await store.recordHistoryNavigation("https://example.com/prefix", "Needle starts here");
    await store.recordHistoryNavigation("https://example.com/substring", "Contains needle later");

    const result = await store.query("needle", 1);

    expect(result.history.map((entry) => entry.title)).toEqual(["Needle starts here"]);
  });

  it("surfaces corrupt and oversized persisted data", async () => {
    const corrupt = await storeAt();
    await fs.writeFile(corrupt.filePath, "not json");
    await expect(new BrowserLibraryStore(corrupt.filePath).query("")).rejects.toThrow(
      "invalid data",
    );

    const oversized = await storeAt();
    await fs.writeFile(oversized.filePath, "x".repeat(512 * 1024 + 1));
    await expect(new BrowserLibraryStore(oversized.filePath).query("")).rejects.toThrow(
      "size limit",
    );
  });

  it("rejects non-web URLs rather than persisting sensitive schemes", async () => {
    const { store } = await storeAt();
    await expect(store.recordHistoryNavigation("file:///tmp/secret", "Secret")).rejects.toThrow(
      "HTTP or HTTPS",
    );
    await expect(store.setBookmark("data:text/plain,secret", "Secret", true)).rejects.toThrow(
      "HTTP or HTTPS",
    );
  });

  it("rejects an overlong navigation asynchronously with a user-facing reason", async () => {
    const { store } = await storeAt();
    let operation: Promise<unknown> | null = null;
    expect(() => {
      operation = store.recordHistoryNavigation(`https://example.com/${"x".repeat(2_100)}`, "Page");
    }).not.toThrow();
    await expect(operation).rejects.toThrow("address exceeds 2048 characters");
  });
});

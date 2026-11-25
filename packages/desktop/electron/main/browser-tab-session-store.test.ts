import { promises as fs } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserTabSessionStore } from "./browser-tab-session-store";

const temporaryDirectories: string[] = [];

async function storeAt(): Promise<{ filePath: string; store: BrowserTabSessionStore }> {
  const directory = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "cadencr-tabs-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "browser-tabs.json");
  return { filePath, store: new BrowserTabSessionStore(filePath) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

describe("BrowserTabSessionStore", () => {
  it("atomically persists independent feature scopes", async () => {
    const { filePath, store } = await storeAt();
    await Promise.all([
      store.replaceScope(41, {
        tabs: [
          {
            title: "One",
            url: "https://example.com/one",
            sessionProfileId: "default",
            pinned: true,
          },
        ],
        activeIndex: 0,
      }),
      store.replaceScope(42, {
        tabs: [
          {
            title: "Two",
            url: "http://localhost:1420/two",
            sessionProfileId: "work",
            pinned: false,
          },
        ],
        activeIndex: 0,
      }),
    ]);

    const restarted = new BrowserTabSessionStore(filePath);
    expect(await restarted.loadScope(41)).toMatchObject({
      tabs: [{ title: "One", url: "https://example.com/one", pinned: true }],
    });
    expect(await restarted.loadScope(42)).toMatchObject({
      tabs: [{ title: "Two", sessionProfileId: "work" }],
    });
  });

  it("preserves the title origin for restored tabs whose first navigation failed", async () => {
    const { filePath, store } = await storeAt();
    const page = {
      title: "New tab",
      url: "http://localhost:4000/",
      sessionProfileId: "default",
      pinned: false,
    };
    await store.replaceScope(1, { tabs: [{ ...page, defaultTitle: true }, page], activeIndex: 0 });
    expect((await new BrowserTabSessionStore(filePath).loadScope(1))?.tabs).toEqual([
      { ...page, defaultTitle: true },
      page,
    ]);
  });

  it("removes an empty scope without touching the others", async () => {
    const { filePath, store } = await storeAt();
    const scope = {
      tabs: [
        {
          title: "Page",
          url: "about:blank",
          sessionProfileId: "default",
          pinned: false,
        },
      ],
      activeIndex: 0,
    };
    await store.replaceScope(1, scope);
    await store.replaceScope(2, scope);
    await store.replaceScope(1, null);

    const restarted = new BrowserTabSessionStore(filePath);
    expect(await restarted.loadScope(1)).toBeNull();
    expect(await restarted.loadScope(2)).toEqual(scope);
  });

  it("returns defensive copies and strips URL credentials", async () => {
    const { filePath, store } = await storeAt();
    await store.replaceScope(7, {
      tabs: [
        {
          title: "  Account   page  ",
          url: "https://alice:secret@example.com/account",
          sessionProfileId: "custom_work",
          pinned: false,
        },
      ],
      activeIndex: 0,
    });

    const first = await store.loadScope(7);
    if (!first) throw new Error("Expected saved scope");
    first.tabs[0]!.title = "Mutated";
    first.tabs.push({ ...first.tabs[0]!, title: "Injected" });

    expect(await store.loadScope(7)).toEqual({
      tabs: [
        {
          title: "Account page",
          url: "https://example.com/account",
          sessionProfileId: "custom_work",
          pinned: false,
        },
      ],
      activeIndex: 0,
    });
    expect(await new BrowserTabSessionStore(filePath).loadScope(7)).toEqual(
      await store.loadScope(7),
    );
  });

  it("surfaces malformed, invalid-URL, private-profile, and oversized data", async () => {
    const malformed = await storeAt();
    await fs.writeFile(malformed.filePath, "not json");
    await expect(new BrowserTabSessionStore(malformed.filePath).loadScope(1)).rejects.toThrow(
      "corrupt",
    );

    for (const tab of [
      { title: "Secret", url: "file:///tmp/secret", sessionProfileId: "default", pinned: false },
      {
        title: "Private",
        url: "https://private.example",
        sessionProfileId: "fresh",
        pinned: false,
      },
    ]) {
      const invalid = await storeAt();
      await fs.writeFile(
        invalid.filePath,
        JSON.stringify({ version: 1, scopes: { "1": { tabs: [tab], activeIndex: 0 } } }),
      );
      await expect(new BrowserTabSessionStore(invalid.filePath).loadScope(1)).rejects.toThrow(
        "invalid",
      );
    }

    const oversized = await storeAt();
    await fs.writeFile(oversized.filePath, "x".repeat(1024 * 1024 + 1));
    await expect(new BrowserTabSessionStore(oversized.filePath).loadScope(1)).rejects.toThrow(
      "storage limit",
    );
  });

  it("does not overwrite corrupt data after a failed load", async () => {
    const { filePath } = await storeAt();
    await fs.writeFile(filePath, "keep this corrupt payload");
    const store = new BrowserTabSessionStore(filePath);

    await expect(
      store.replaceScope(1, {
        tabs: [
          {
            title: "Page",
            url: "https://example.com",
            sessionProfileId: "default",
            pinned: false,
          },
        ],
        activeIndex: 0,
      }),
    ).rejects.toThrow("corrupt");
    expect(await fs.readFile(filePath, "utf8")).toBe("keep this corrupt payload");
  });

  it("keeps the confirmed snapshot and recovers its serialized queue after write failure", async () => {
    const { filePath, store } = await storeAt();
    await store.replaceScope(1, {
      tabs: [
        {
          title: "Confirmed",
          url: "https://example.com/confirmed",
          sessionProfileId: "default",
          pinned: false,
        },
      ],
      activeIndex: 0,
    });
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk full"));

    await expect(
      store.replaceScope(1, {
        tabs: [
          {
            title: "Uncommitted",
            url: "https://example.com/uncommitted",
            sessionProfileId: "default",
            pinned: false,
          },
        ],
        activeIndex: 0,
      }),
    ).rejects.toThrow("disk full");
    expect((await store.loadScope(1))?.tabs[0]?.title).toBe("Confirmed");

    await store.replaceScope(1, {
      tabs: [
        {
          title: "Recovered",
          url: "https://example.com/recovered",
          sessionProfileId: "default",
          pinned: false,
        },
      ],
      activeIndex: 0,
    });
    expect((await new BrowserTabSessionStore(filePath).loadScope(1))?.tabs[0]?.title).toBe(
      "Recovered",
    );
  });
});

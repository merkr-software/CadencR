// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isUpdateAvailable } from "./update-check";

// A Vite-built index.html shell pointing at a content-hashed entry bundle, in
// the exact relative form the real build emits (`./assets/index-<hash>.js`).
function indexHtml(entry: string): string {
  return `<!doctype html><html><head>\
<script type="module" crossorigin src="${entry}"></script>\
<link rel="stylesheet" crossorigin href="./assets/index-x.css"></head><body></body></html>`;
}

function mockServed(entry: string): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, text: async () => indexHtml(entry) })),
  );
}

describe("isUpdateAvailable", () => {
  beforeEach(() => {
    // The running entry is read from the live DOM, mirroring the booted bundle.
    document.head.innerHTML = `<script type="module" crossorigin src="./assets/index-RUNNING.js"></script>`;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.head.innerHTML = "";
  });

  it("is true when the served entry bundle differs from the running one", async () => {
    mockServed("./assets/index-NEW.js");
    expect(await isUpdateAvailable()).toBe(true);
  });

  it("is false when the served entry bundle matches the running one", async () => {
    mockServed("./assets/index-RUNNING.js");
    expect(await isUpdateAvailable()).toBe(false);
  });

  it("is false (and does not fetch) when no hashed entry is running (dev build)", async () => {
    document.head.innerHTML = `<script type="module" src="/src/main.tsx"></script>`;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await isUpdateAvailable()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is false and leaves a breadcrumb when the check fails transiently", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(await isUpdateAvailable()).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it("is false when the served document is unreadable (non-OK response)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503, text: async () => "" })),
    );
    expect(await isUpdateAvailable()).toBe(false);
  });
});

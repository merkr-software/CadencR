import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, BrowserWindow: class {}, screen: {} }));

import { notchPageUrl } from "./notch-island-window";

describe("notchPageUrl", () => {
  it("loads the island from the other loopback name so it never shares the app's zoom", () => {
    expect(notchPageUrl("http://127.0.0.1:1421/")).toBe("http://localhost:1421/notch.html");
    expect(notchPageUrl("http://localhost:1420")).toBe("http://127.0.0.1:1420/notch.html");
  });
});

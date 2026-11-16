// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { elementContextScript } from "./browser-element-context-script";

describe("elementContextScript", () => {
  it("settles and restores the page when navigation abandons the picker", async () => {
    document.documentElement.style.cursor = "pointer";
    const selection: unknown = window.eval(elementContextScript(null));

    expect(document.documentElement.style.cursor).toBe("crosshair");
    window.dispatchEvent(new Event("pagehide"));

    await expect(selection).resolves.toBeNull();
    expect(document.documentElement.style.cursor).toBe("pointer");
  });
});

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { secureSplashWebContents } from "./splash-security";

function contents() {
  return Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
}

describe("splash navigation boundary", () => {
  it("blocks every navigation and dispatches only recognized recovery actions", () => {
    const wc = contents();
    const onAction = vi.fn();
    secureSplashWebContents(wc as unknown as Electron.WebContents, onAction);
    for (const url of [
      "https://evil.test/",
      "file:///tmp/hostile.html",
      "javascript:alert(1)",
      "cadencr-splash://action/not-an-action",
      "cadencr-splash://action/quit",
    ]) {
      const event = { url, preventDefault: vi.fn() };
      wc.emit("will-navigate", event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    expect(onAction).toHaveBeenCalledExactlyOnceWith("quit");
    const redirect = { preventDefault: vi.fn() };
    wc.emit("will-redirect", redirect, "https://evil.test/");
    expect(redirect.preventDefault).toHaveBeenCalledOnce();
    const subframe = { isMainFrame: false, preventDefault: vi.fn() };
    wc.emit("will-frame-navigate", subframe);
    expect(subframe.preventDefault).toHaveBeenCalledOnce();
    const open = wc.setWindowOpenHandler.mock.calls[0][0] as () => { action: string };
    expect(open()).toEqual({ action: "deny" });
  });
});

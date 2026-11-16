// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import { resetWindowFocusForTests } from "@/lib/window-focus";
import { subscribeForgeStatus } from "./forge-visibility";

afterEach(() => {
  vi.restoreAllMocks();
  clearDesktopBridgeOverrideForTests();
  resetWindowFocusForTests();
});

const sent = (send: ReturnType<typeof vi.fn>, call: number): unknown =>
  JSON.parse(String(send.mock.calls[call]?.[0]));

describe("subscribeForgeStatus", () => {
  it("subscribes once and reports focus changes until cleanup", () => {
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const send = vi.fn();
    const ws = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;

    const cleanup = subscribeForgeStatus(ws);
    expect(JSON.parse(String(send.mock.calls[0]?.[0]))).toMatchObject({
      domain: "app",
      action: "subscribe.forge_status",
      payload: { visible: true },
    });

    hasFocus.mockReturnValue(false);
    window.dispatchEvent(new Event("blur"));
    expect(JSON.parse(String(send.mock.calls[1]?.[0]))).toMatchObject({
      action: "forge_visibility",
      payload: { visible: false },
    });

    cleanup();
    window.dispatchEvent(new Event("focus"));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("stays visible while a guest view inside the focused window has focus", async () => {
    let focusChanged: (focused: boolean) => void = () => undefined;
    setDesktopBridgeOverrideForTests({
      isWindowFocused: () => Promise.resolve(true),
      onWindowFocusChange: (cb) => {
        focusChanged = cb;
        return () => undefined;
      },
    });
    // A custom tab took the focus: this document is blurred, the window is not.
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const send = vi.fn();
    const ws = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;

    const cleanup = subscribeForgeStatus(ws);
    await vi.waitFor(() =>
      expect(sent(send, send.mock.calls.length - 1)).toMatchObject({ payload: { visible: true } }),
    );
    window.dispatchEvent(new Event("blur"));
    expect(sent(send, send.mock.calls.length - 1)).toMatchObject({
      action: "forge_visibility",
      payload: { visible: true },
    });

    focusChanged(false);
    expect(sent(send, send.mock.calls.length - 1)).toMatchObject({
      action: "forge_visibility",
      payload: { visible: false },
    });
    cleanup();
  });
});

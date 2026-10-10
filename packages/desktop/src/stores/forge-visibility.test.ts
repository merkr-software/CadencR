// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeForgeStatus } from "./forge-visibility";

afterEach(() => vi.restoreAllMocks());

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
});

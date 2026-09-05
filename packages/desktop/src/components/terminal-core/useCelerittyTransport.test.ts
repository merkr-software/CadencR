import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCelerittyTransport } from "./useCelerittyTransport";
import { useNeovimTransport } from "../editor/neovim/useNeovimTransport";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("terminal transport bridges", () => {
  it("preserves startup output and listener identity as the shell socket changes state", async () => {
    const first = { write: vi.fn(), resize: vi.fn(), isConnected: false };
    const { result, rerender } = renderHook((socket) => useCelerittyTransport(socket), {
      initialProps: first,
    });
    const bridge = result.current;
    bridge.deliverData("startup ");
    const next = { write: vi.fn(), resize: vi.fn(), isConnected: true };
    rerender(next);
    expect(result.current).toBe(bridge);
    const output: string[] = [];
    bridge.transport.onData((bytes) => output.push(decoder.decode(bytes)));
    bridge.deliverData("prompt");
    expect(output).toEqual([]);
    await act(async () => {});
    expect(output.join("")).toBe("startup prompt");
    bridge.transport.write(encoder.encode("ls\n"));
    bridge.transport.resize(100, 40);
    expect(next.write).toHaveBeenCalledWith("ls\n");
    expect(next.resize).toHaveBeenCalledWith(100, 40);
    expect(first.write).not.toHaveBeenCalled();
  });

  it("replaces buffered output with the reconnect snapshot before later live data", async () => {
    const { result } = renderHook(() => useCelerittyTransport({ write: vi.fn(), resize: vi.fn() }));
    result.current.deliverData("stale");
    result.current.deliverSnapshot("history");
    result.current.deliverData("live");
    const output: string[] = [];
    const unsubscribe = result.current.transport.onData((bytes) =>
      output.push(decoder.decode(bytes)),
    );
    await act(async () => {});
    expect(output.join("")).toBe("\x1bchistorylive");
    unsubscribe();
    result.current.deliverData("while detached");
    result.current.transport.onData((bytes) => output.push(decoder.decode(bytes)));
    await act(async () => {});
    expect(output.join("")).toBe("\x1bchistorylivewhile detached");
  });

  it("replays a reconnect while already attached, including an empty snapshot reset", async () => {
    const { result } = renderHook(() => useCelerittyTransport({ write: vi.fn(), resize: vi.fn() }));
    const output: string[] = [];
    result.current.transport.onData((bytes) => output.push(decoder.decode(bytes)));
    await act(async () => {});
    result.current.deliverData("old");
    result.current.deliverSnapshot("old plus missed");
    result.current.deliverSnapshot("");
    expect(output.join("")).toBe("old\x1bcold plus missed\x1bc");
  });

  it("shares the lossless startup queue and stable subscriptions with Neovim", async () => {
    const { result, rerender } = renderHook((socket) => useNeovimTransport(socket), {
      initialProps: { write: vi.fn(), resize: vi.fn() },
    });
    const bridge = result.current;
    const bytes = encoder.encode("é editor");
    bridge.deliverData(bytes);
    bytes.fill(0);
    rerender({ write: vi.fn(), resize: vi.fn() });
    expect(result.current).toBe(bridge);
    const received: string[] = [];
    bridge.transport.onData((data) => received.push(decoder.decode(data)));
    await act(async () => {});
    expect(received.join("")).toBe("é editor");
  });

  it("replays buffered exit output before notifying an attaching terminal of closure", async () => {
    const { result } = renderHook(() => useCelerittyTransport({ write: vi.fn(), resize: vi.fn() }));
    result.current.deliverData("last output");
    result.current.deliverClose("exited");
    const events: string[] = [];
    result.current.transport.onData((bytes) => events.push(decoder.decode(bytes)));
    result.current.transport.onClose((reason) => events.push(reason ?? "closed"));
    await act(async () => {});
    expect(events).toEqual(["last output", "exited"]);
  });
});

describe("bounded terminal startup buffering", () => {
  it.each(["bytes", "chunks"])(
    "fails visibly at the %s limit without corrupting replay",
    async (limit) => {
      const { result } = renderHook(() =>
        useCelerittyTransport({ write: vi.fn(), resize: vi.fn() }),
      );
      const chunk = limit === "bytes" ? "x".repeat(1024) : "x";
      const count = limit === "bytes" ? 1024 : 4096;
      for (let i = 0; i < count + 100; i++) result.current.deliverData(chunk);
      const events: string[] = [];
      result.current.transport.onData((bytes) => events.push(decoder.decode(bytes)));
      result.current.transport.onClose((reason) => events.push(reason ?? "closed"));
      await act(async () => {});
      expect(events.slice(0, -1).join("")).toBe(chunk.repeat(count));
      expect(events.at(-1)).toContain("Terminal output buffer full");
      const length = events.length;
      result.current.deliverData("still closed");
      expect(events).toHaveLength(length);
      result.current.deliverSnapshot("recovered");
      result.current.deliverData(" live");
      expect(events.slice(length).join("")).toBe("\x1bcrecovered live");
    },
  );

  it("does not limit output when the renderer is consuming it", async () => {
    const { result } = renderHook(() => useCelerittyTransport({ write: vi.fn(), resize: vi.fn() }));
    const received = vi.fn();
    const closed = vi.fn();
    result.current.transport.onData(received);
    result.current.transport.onClose(closed);
    await act(async () => {});
    result.current.deliverData("x".repeat(2 * 1024 * 1024));
    expect(received).toHaveBeenCalledOnce();
    expect(closed).not.toHaveBeenCalled();
  });
});

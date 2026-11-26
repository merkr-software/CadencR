import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { featureBridgeToken } from "./browser-bridge-auth";
import { dispatchBrowserBridgePayload, handleBrowserBridgeRequest } from "./browser-bridge-server";

describe("browser bridge server", () => {
  it("rejects requests without the bearer token", async () => {
    const result = await dispatchBrowserBridgePayload("", "secret", "{}", vi.fn());

    expect(result.status).toBe(401);
  });

  it("dispatches authenticated browser tool requests with the calling feature scope", async () => {
    const dispatch = vi.fn(async () => ({ text: "tabs: []" }));
    const result = await dispatchBrowserBridgePayload(
      "Bearer secret",
      "secret",
      JSON.stringify({
        tool_name: "browser_list_tabs",
        args: {},
        feature_id: 7,
      }),
      dispatch,
    );

    expect(result).toEqual({ status: 200, payload: { text: "tabs: []" } });
    expect(dispatch).toHaveBeenCalledWith("browser_list_tabs", {}, 7);
  });

  it("passes through an image payload for screenshot tools", async () => {
    const dispatch = vi.fn(async () => ({
      text: '{"format":"png"}',
      image: { mimeType: "image/png", data: "AAAA" },
    }));
    const result = await dispatchBrowserBridgePayload(
      "Bearer secret",
      "secret",
      JSON.stringify({ tool_name: "browser_screenshot", args: {} }),
      dispatch,
    );

    expect(result).toEqual({
      status: 200,
      payload: {
        text: '{"format":"png"}',
        image: { mimeType: "image/png", data: "AAAA" },
      },
    });
  });

  it("keeps a feature-scoped caller inside its own feature", async () => {
    const dispatch = vi.fn(async () => ({ text: "ok" }));
    const header = `Bearer ${featureBridgeToken("secret", 7)}`;
    const call = (body: object) =>
      dispatchBrowserBridgePayload(header, "secret", JSON.stringify(body), dispatch);

    expect(await call({ tool_name: "browser_list_tabs", args: {}, feature_id: 7 })).toEqual({
      status: 200,
      payload: { text: "ok" },
    });
    expect((await call({ tool_name: "browser_evaluate", args: {}, feature_id: 8 })).status).toBe(
      403,
    );
    expect((await call({ tool_name: "browser_evaluate", args: {} })).status).toBe(403);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith("browser_list_tabs", {}, 7);
  });

  it("treats null or omitted args as an empty object", async () => {
    const dispatch = vi.fn(async () => ({ text: "ok" }));

    const omitted = await dispatchBrowserBridgePayload(
      "Bearer secret",
      "secret",
      JSON.stringify({ tool_name: "browser_list_tabs", feature_id: 7 }),
      dispatch,
    );
    const nulled = await dispatchBrowserBridgePayload(
      "Bearer secret",
      "secret",
      JSON.stringify({ tool_name: "browser_list_tabs", args: null, feature_id: 7 }),
      dispatch,
    );

    expect(omitted).toEqual({ status: 200, payload: { text: "ok" } });
    expect(nulled).toEqual({ status: 200, payload: { text: "ok" } });
    expect(dispatch).toHaveBeenNthCalledWith(1, "browser_list_tabs", {}, 7);
    expect(dispatch).toHaveBeenNthCalledWith(2, "browser_list_tabs", {}, 7);
  });

  it("rejects non-object args such as strings or arrays", async () => {
    const dispatch = vi.fn(async () => ({ text: "ok" }));

    await expect(
      dispatchBrowserBridgePayload(
        "Bearer secret",
        "secret",
        JSON.stringify({ tool_name: "browser_list_tabs", args: "foo" }),
        dispatch,
      ),
    ).rejects.toThrow("Expected args object.");
    await expect(
      dispatchBrowserBridgePayload(
        "Bearer secret",
        "secret",
        JSON.stringify({ tool_name: "browser_list_tabs", args: [] }),
        dispatch,
      ),
    ).rejects.toThrow("Expected args object.");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("passes an AbortSignal that stays live for normal calls and aborts when the client disconnects", async () => {
    function fakeReqRes(body: string) {
      const req = Object.assign(new EventEmitter(), {
        method: "POST",
        url: "/browser-bridge",
        headers: { authorization: "Bearer secret" },
        setEncoding: vi.fn(),
      });
      const res = Object.assign(new EventEmitter(), {
        writableEnded: false,
        status: 0,
        body: "",
        writeHead(status: number) {
          this.status = status;
        },
        end(chunk?: string) {
          this.body = chunk ?? "";
          this.writableEnded = true;
        },
      });
      queueMicrotask(() => {
        req.emit("data", body);
        req.emit("end");
      });
      return {
        req: req as unknown as IncomingMessage,
        res: res as unknown as ServerResponse & { status: number; body: string },
        resEmitter: res,
      };
    }

    let observedNormalAborted: boolean | null = null;
    const normal = fakeReqRes(JSON.stringify({ tool_name: "normal", args: {} }));
    await handleBrowserBridgeRequest(
      normal.req,
      normal.res,
      "secret",
      async (_t, _a, _f, signal) => {
        observedNormalAborted = signal?.aborted ?? null;
        return { text: "ok" };
      },
    );
    expect(normal.res.status).toBe(200);
    expect(observedNormalAborted).toBe(false);

    let disconnectSignal: AbortSignal | undefined;
    const disconnected = fakeReqRes(JSON.stringify({ tool_name: "hang", args: {} }));
    const pending = handleBrowserBridgeRequest(
      disconnected.req,
      disconnected.res,
      "secret",
      async (_t, _a, _f, signal) => {
        disconnectSignal = signal;
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { text: "done" };
      },
    );
    await vi.waitFor(() => expect(disconnectSignal).toBeDefined());
    expect(disconnectSignal?.aborted).toBe(false);

    disconnected.resEmitter.emit("close");
    expect(disconnectSignal?.aborted).toBe(true);
    await pending;
  });
});

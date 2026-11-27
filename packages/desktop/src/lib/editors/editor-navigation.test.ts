import { describe, expect, it, vi } from "vitest";
import type { EditorOpenFileParams } from "@cadencr/tab-sdk/protocol";
import { pluginTabSummary } from "@/components/plugin-tabs/plugin-tab-fixtures";
import { EditorNavigationController } from "./editor-navigation";
import { PluginSurfaceRegistry } from "./surface-registry";
import type { EditorTarget } from "./editor-registry";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const surfaces = new PluginSurfaceRegistry();
  const fallback = vi.fn();
  const opened = vi.fn();
  const report = vi.fn();
  const builtin = { open: vi.fn().mockResolvedValue(undefined), focus: vi.fn() };
  const controller = new EditorNavigationController({ surfaces, builtin, report });
  const plugin = pluginTabSummary({
    id: "example-editor",
    editor: { label: "Example editor", open_method: "files.open" },
  });
  const request = {
    featureId: 7,
    target: { kind: "plugin" as const, id: "plugin:example-editor", plugin },
    params: { path: "src/main.rs", line: 12, column: 3 },
    reveal: vi.fn(),
    fallback,
    opened,
  };
  return { surfaces, controller, request, fallback, opened, report, builtin };
}

describe("acknowledged editor navigation", () => {
  it("does not focus a lazy surface after its tab has been left", async () => {
    const { controller, surfaces, request } = setup();
    let active = true;
    const focus = vi.fn();
    const focusing = controller.focus(7, request.target, () => active);
    active = false;
    surfaces.register("7:editor:example-editor", { requestBackend: vi.fn(), focus });
    await focusing;
    expect(focus).not.toHaveBeenCalled();
  });
  it("reveals the surface, waits for availability, then focuses only after acknowledgement", async () => {
    const { controller, surfaces, request, opened } = setup();
    const acknowledgement = deferred<{ result: unknown }>();
    const focus = vi.fn();
    const backend = vi.fn().mockReturnValue(acknowledgement.promise);
    const opening = controller.open(request);
    expect(request.reveal).toHaveBeenCalledOnce();
    expect(backend).not.toHaveBeenCalled();
    const release = surfaces.register("7:editor:example-editor", {
      requestBackend: backend,
      focus,
    });
    await vi.waitFor(() => expect(backend).toHaveBeenCalledWith("files.open", request.params));
    expect(focus).not.toHaveBeenCalled();
    acknowledgement.resolve({ result: { opened: request.params } });
    await opening;
    expect(opened).toHaveBeenCalledWith(request.params);
    expect(focus).toHaveBeenCalledOnce();
    release();
  });

  it("reports a backend refusal and opens CodeMirror without replaying the request", async () => {
    const { controller, surfaces, request, fallback, report, opened } = setup();
    const focus = vi.fn();
    const backend = vi.fn().mockResolvedValue({ error: { code: "REFUSED", message: "Read-only" } });
    surfaces.register("7:editor:example-editor", { requestBackend: backend, focus });
    await controller.open(request);
    expect(backend).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: "Read-only" }));
    expect(fallback).toHaveBeenCalledWith(request.params, expect.any(String));
    expect(opened).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it("prevents a late acknowledgement from focusing or replacing a newer navigation", async () => {
    const { controller, surfaces, request, opened } = setup();
    const first = deferred<{ result: unknown }>();
    const focus = vi.fn();
    const backend = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ result: null });
    surfaces.register("7:editor:example-editor", { requestBackend: backend, focus });
    const opening = controller.open(request);
    await vi.waitFor(() => expect(backend).toHaveBeenCalledOnce());
    const newer: EditorOpenFileParams = { path: "second.rs", line: 1 };
    await controller.open({ ...request, params: newer });
    first.resolve({ result: null });
    await opening;
    expect(opened).toHaveBeenCalledExactlyOnceWith(newer);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("keeps navigation isolated between conversations", async () => {
    const { controller, surfaces, request, opened } = setup();
    const focus7 = vi.fn();
    const focus8 = vi.fn();
    surfaces.register("7:editor:example-editor", {
      requestBackend: vi.fn().mockResolvedValue({ result: null }),
      focus: focus7,
    });
    surfaces.register("8:editor:example-editor", {
      requestBackend: vi.fn().mockResolvedValue({ result: null }),
      focus: focus8,
    });
    await Promise.all([controller.open(request), controller.open({ ...request, featureId: 8 })]);
    expect(focus7).toHaveBeenCalledOnce();
    expect(focus8).toHaveBeenCalledOnce();
    expect(opened).toHaveBeenCalledTimes(2);
  });

  it("reports an unavailable surface and falls back within a bounded wait", async () => {
    const { controller, request, fallback } = setup();
    await controller.open({ ...request, timeoutMs: 5 });
    expect(fallback).toHaveBeenCalledWith(request.params, expect.stringContaining("surface"));
  });

  it("routes CodeMirror without requesting a plugin backend", async () => {
    const { controller, request, fallback, builtin } = setup();
    await controller.open({ ...request, target: { kind: "codemirror", id: "codemirror" } });
    expect(fallback).toHaveBeenCalledWith(request.params, undefined);
    expect(builtin.open).not.toHaveBeenCalled();
  });

  it("keeps native Neovim behind the built-in editor adapter", async () => {
    const { controller, request, builtin, opened } = setup();
    await controller.open({ ...request, target: { kind: "neovim", id: "neovim" } });
    expect(builtin.open).toHaveBeenCalledWith(
      7,
      request.params,
      request.reveal,
      expect.any(Function),
    );
    expect(opened).toHaveBeenCalledWith(request.params);
    expect(builtin.focus).toHaveBeenCalledWith(7, expect.any(Function));
  });

  it("starts ordering before resolving asynchronous settings", async () => {
    const { controller, request, surfaces, opened } = setup();
    const selection = deferred<EditorTarget>();
    const backend = vi.fn().mockResolvedValue({ result: null });
    surfaces.register("7:editor:example-editor", { requestBackend: backend, focus: vi.fn() });
    const older = controller.open({ ...request, target: () => selection.promise });
    const params = { path: "newer.rs" };
    await controller.open({ ...request, params });
    selection.resolve(request.target);
    await older;
    expect(backend).toHaveBeenCalledExactlyOnceWith("files.open", params);
    expect(opened).toHaveBeenCalledExactlyOnceWith(params);
  });

  it("rejects malformed positions without forwarding them to either editor", async () => {
    const { controller, request, fallback, report } = setup();
    await controller.open({ ...request, params: { path: "main.rs", line: 0 } });
    expect(report).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    expect(request.reveal).not.toHaveBeenCalled();
  });

  it("does not focus a recycled surface or accept its delayed acknowledgement", async () => {
    const { controller, request, surfaces, opened } = setup();
    const ack = deferred<{ result: unknown }>();
    const oldFocus = vi.fn();
    const newFocus = vi.fn();
    const oldBackend = vi.fn().mockReturnValue(ack.promise);
    const release = surfaces.register("7:editor:example-editor", {
      requestBackend: oldBackend,
      focus: oldFocus,
    });
    const opening = controller.open(request);
    await vi.waitFor(() => expect(oldBackend).toHaveBeenCalled());
    surfaces.register("7:editor:example-editor", { requestBackend: vi.fn(), focus: newFocus });
    release();
    ack.resolve({ result: null });
    await opening;
    expect(opened).not.toHaveBeenCalled();
    expect(oldFocus).not.toHaveBeenCalled();
    expect(await surfaces.focus("7:editor:example-editor")).toBe(true);
    expect(newFocus).toHaveBeenCalledOnce();
  });

  it("does not steal focus after the user changes the editor selection", async () => {
    const { controller, request, surfaces, fallback, opened } = setup();
    const ack = deferred<{ result: unknown }>();
    let selected = true;
    const backend = vi.fn().mockReturnValue(ack.promise);
    const focus = vi.fn();
    surfaces.register("7:editor:example-editor", { requestBackend: backend, focus });
    const opening = controller.open({ ...request, isCurrent: () => selected });
    await vi.waitFor(() => expect(backend).toHaveBeenCalled());
    selected = false;
    ack.resolve({ result: null });
    await opening;
    expect(focus).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  });
});

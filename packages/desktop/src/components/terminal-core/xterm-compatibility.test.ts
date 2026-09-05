import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalOptions, TerminalTransport } from "celeritty";
import { DEFAULT_TERMINAL_PALETTE } from "./terminal-palette";

const mocks = vi.hoisted(() => {
  class MockXterm {
    static instances: MockXterm[] = [];
    options: Record<string, unknown>;
    element: HTMLElement | undefined;
    cols = 100;
    rows = 40;
    selection = "";
    data = new Set<(data: string) => void>();
    resize = new Set<(size: { cols: number; rows: number }) => void>();
    selectionChange = new Set<() => void>();
    loadAddon = vi.fn();
    write = vi.fn<(data: string | Uint8Array) => void>();
    focus = vi.fn();
    blur = vi.fn();
    scrollLines = vi.fn();
    scrollToBottom = vi.fn();
    getSelection = vi.fn(() => this.selection);
    dispose = vi.fn(() => {
      this.data.clear();
      this.resize.clear();
      this.selectionChange.clear();
    });
    open = vi.fn((host: HTMLElement) => {
      this.element = host;
    });
    constructor(options: Record<string, unknown>) {
      this.options = options;
      MockXterm.instances.push(this);
    }
    onData(callback: (data: string) => void) {
      this.data.add(callback);
      return { dispose: () => this.data.delete(callback) };
    }
    onResize(callback: (size: { cols: number; rows: number }) => void) {
      this.resize.add(callback);
      return { dispose: () => this.resize.delete(callback) };
    }
    onSelectionChange(callback: () => void) {
      this.selectionChange.add(callback);
      return { dispose: () => this.selectionChange.delete(callback) };
    }
  }
  const fit = vi.fn();
  const links = {
    activate: undefined as ((event: MouseEvent, url: string) => void) | undefined,
    hover: undefined as ((event: MouseEvent, url: string) => void) | undefined,
    leave: undefined as (() => void) | undefined,
  };
  return { MockXterm, fit, links };
});
vi.mock("@xterm/xterm", () => ({ Terminal: mocks.MockXterm }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit = mocks.fit;
  },
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    constructor(activate: typeof mocks.links.activate, options: typeof mocks.links) {
      mocks.links.activate = activate;
      mocks.links.hover = options.hover;
      mocks.links.leave = options.leave;
    }
  },
}));

import { XtermCompatibility } from "./xterm-compatibility";

const encoder = new TextEncoder();
const originalResizeObserver = globalThis.ResizeObserver;
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
let resizeObserverCallback: ResizeObserverCallback;
const disconnectObserver = vi.fn();
const observe = vi.fn();
const adapters: XtermCompatibility[] = [];
const options: TerminalOptions = {
  font: { family: "monospace", size: 14, lineHeight: 1.4 },
  colors: DEFAULT_TERMINAL_PALETTE,
  cursor: { style: "beam", blink: true },
  scrollback: 1000,
};

function createAdapter() {
  const host = document.createElement("div");
  Object.defineProperties(host, {
    clientWidth: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 500 },
  });
  const adapter = new XtermCompatibility(host, options);
  adapters.push(adapter);
  return { host, adapter, term: mocks.MockXterm.instances.at(-1)! };
}
function createTransport(overrides: Partial<TerminalTransport> = {}) {
  const data = new Set<(bytes: Uint8Array) => void>();
  const close = new Set<(reason?: string) => void>();
  const transport = {
    write: vi.fn(),
    resize: vi.fn(),
    onData: vi.fn((callback: (bytes: Uint8Array) => void) => {
      data.add(callback);
      return () => {
        data.delete(callback);
      };
    }),
    onClose: vi.fn((callback: (reason?: string) => void) => {
      close.add(callback);
      return () => {
        close.delete(callback);
      };
    }),
    ...overrides,
  };
  return { transport, data, close };
}
function resizeHost() {
  resizeObserverCallback([], {} as ResizeObserver);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fit.mockReset();
  mocks.MockXterm.instances = [];
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      resizeObserverCallback = callback;
    }
    observe = observe;
    unobserve = vi.fn();
    disconnect = disconnectObserver;
  };
});
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.dispose();
  globalThis.ResizeObserver = originalResizeObserver;
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("xterm compatibility lifecycle and transport", () => {
  it("opens with mapped options and publishes the fitted grid on attachment", async () => {
    const { adapter, host, term } = createAdapter();
    await adapter.ready;
    expect(term.open).toHaveBeenCalledWith(host);
    expect(term.loadAddon).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenCalledWith(host);
    expect(mocks.fit).toHaveBeenCalledOnce();
    expect(term.options).toMatchObject({
      fontFamily: "monospace",
      fontSize: 14,
      lineHeight: 1.4,
      cursorStyle: "bar",
      cursorBlink: true,
      scrollback: 1000,
      theme: DEFAULT_TERMINAL_PALETTE,
      allowProposedApi: false,
      allowTransparency: true,
      macOptionIsMeta: true,
      fontWeightBold: "600",
      cursorWidth: 2,
    });
    const { transport } = createTransport();
    adapter.attach(transport);
    expect(adapter.transport).toBe(transport);
    expect(transport.resize).toHaveBeenCalledWith(100, 40);
  });

  it("forwards byte output, Unicode input and resizes exactly once", () => {
    const { adapter, term } = createAdapter();
    const { transport, data } = createTransport();
    adapter.attach(transport);
    const bytes = encoder.encode("é 中 🚀");
    for (const callback of data) callback(bytes);
    expect(term.write).toHaveBeenCalledExactlyOnceWith(bytes);
    for (const callback of term.data) callback("é 中 🚀");
    expect(transport.write).toHaveBeenCalledExactlyOnceWith(bytes);
    for (const callback of term.resize) callback({ cols: 120, rows: 50 });
    expect(transport.resize).toHaveBeenLastCalledWith(120, 50);
  });

  it("replaces and detaches transports without duplicating listeners", () => {
    const { adapter, term } = createAdapter();
    const first = createTransport();
    const second = createTransport();
    adapter.attach(first.transport);
    adapter.attach(second.transport);
    expect(first.data.size).toBe(0);
    expect(first.close.size).toBe(0);
    for (const callback of term.data) callback("x");
    expect(first.transport.write).not.toHaveBeenCalled();
    expect(second.transport.write).toHaveBeenCalledOnce();
    adapter.detach();
    adapter.detach();
    expect(adapter.transport).toBeUndefined();
    expect(second.data.size).toBe(0);
    expect(second.close.size).toBe(0);
    for (const callback of term.data) callback("y");
    expect(second.transport.write).toHaveBeenCalledOnce();
  });

  it("registers parser replies before synchronous startup output is delivered", () => {
    const { adapter, term } = createAdapter();
    term.write.mockImplementation(() => {
      for (const callback of term.data) callback("terminal reply");
    });
    const { transport } = createTransport({
      onData: (callback) => {
        callback(encoder.encode("\x1b[6n"));
        return vi.fn();
      },
    });
    adapter.attach(transport);
    expect(transport.write).toHaveBeenCalledWith(encoder.encode("terminal reply"));
  });

  it("cleans subscriptions when the transport reports closure during registration", () => {
    const { adapter, term } = createAdapter();
    const error = vi.fn();
    adapter.on("error", error);
    const unsubscribeClose = vi.fn();
    const { transport, data } = createTransport({
      onClose: (callback) => {
        callback("already closed");
        return unsubscribeClose;
      },
    });
    adapter.attach(transport);
    expect(adapter.transport).toBeUndefined();
    expect(data.size).toBe(0);
    expect(unsubscribeClose).toHaveBeenCalledOnce();
    expect(transport.resize).not.toHaveBeenCalled();
    for (const callback of term.data) callback("must not reach socket");
    expect(transport.write).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(new Error("already closed"));
  });

  it("detaches cleanly when an established transport closes without an error", () => {
    const { adapter } = createAdapter();
    const error = vi.fn();
    adapter.on("error", error);
    const { transport, close, data } = createTransport();
    adapter.attach(transport);
    for (const callback of close) callback();
    expect(adapter.transport).toBeUndefined();
    expect(data.size).toBe(0);
    expect(error).not.toHaveBeenCalled();
  });
});

describe("xterm compatibility options and sizing", () => {
  it("patches options in place and preserves fields not present in a patch", () => {
    const { adapter, term } = createAdapter();
    adapter.setOptions({ cursor: { style: "underline", blink: false }, scrollback: 0 });
    expect(term.options).toMatchObject({
      cursorStyle: "underline",
      cursorBlink: false,
      scrollback: 0,
      fontFamily: "monospace",
      fontSize: 14,
    });
    adapter.setOptions({ font: { family: "other", size: 18, lineHeight: 0.5 } });
    expect(term.options).toMatchObject({ fontFamily: "other", fontSize: 18, lineHeight: 1 });
    expect(mocks.MockXterm.instances).toHaveLength(1);
  });

  it("does not resize hidden hosts to a tiny PTY and fits again when revealed", () => {
    const { host, adapter } = createAdapter();
    mocks.fit.mockClear();
    Object.defineProperty(host, "clientWidth", { configurable: true, value: 0 });
    const { transport } = createTransport();
    adapter.attach(transport);
    expect(transport.resize).not.toHaveBeenCalled();
    resizeHost();
    expect(mocks.fit).not.toHaveBeenCalled();
    Object.defineProperty(host, "clientWidth", { configurable: true, value: 900 });
    resizeHost();
    expect(mocks.fit).toHaveBeenCalledOnce();
  });

  it("surfaces resize observer failures through the engine error event", () => {
    const { adapter } = createAdapter();
    const error = vi.fn();
    adapter.on("error", error);
    mocks.fit.mockImplementationOnce(() => {
      throw new Error("fit failed");
    });
    resizeHost();
    expect(error).toHaveBeenCalledWith(new Error("fit failed"));
  });
});

describe("xterm compatibility events and disposal", () => {
  it("forwards link modifiers, hover and selection events with removable listeners", () => {
    const { adapter, term } = createAdapter();
    const activate = vi.fn();
    const hover = vi.fn();
    const selection = vi.fn();
    const off = adapter.on("link-activate", activate);
    adapter.on("link-hover", hover);
    adapter.on("selection-change", selection);
    const event = new MouseEvent("click", { ctrlKey: true, metaKey: true, shiftKey: true });
    mocks.links.activate?.(event, "https://example.test");
    expect(activate).toHaveBeenCalledWith({
      url: "https://example.test",
      modifiers: { ctrl: true, meta: true, shift: true, alt: false },
    });
    mocks.links.hover?.(event, "https://example.test");
    mocks.links.leave?.();
    expect(hover.mock.calls).toEqual([["https://example.test"], [null]]);
    term.selection = "selected";
    for (const callback of term.selectionChange) callback();
    expect(selection).toHaveBeenCalledWith("selected");
    term.selection = "";
    for (const callback of term.selectionChange) callback();
    expect(selection).toHaveBeenLastCalledWith(null);
    off();
    mocks.links.activate?.(event, "https://ignored.test");
    expect(activate).toHaveBeenCalledOnce();
  });

  it("delegates local writing, focus, scrolling and clipboard without sending to the PTY", async () => {
    const { adapter, term } = createAdapter();
    const clipboard = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboard },
    });
    const { transport } = createTransport();
    adapter.attach(transport);
    adapter.write("local notice");
    adapter.clearScreen();
    adapter.focus();
    adapter.blur();
    adapter.scrollLines(-3);
    adapter.scrollToBottom();
    expect(term.write.mock.calls).toEqual([["local notice"], ["\x1b[2J\x1b[H"]]);
    expect(term.focus).toHaveBeenCalledOnce();
    expect(term.blur).toHaveBeenCalledOnce();
    expect(term.scrollLines).toHaveBeenCalledWith(-3);
    expect(term.scrollToBottom).toHaveBeenCalledOnce();
    expect(transport.write).not.toHaveBeenCalled();
    await adapter.copySelection();
    expect(clipboard).not.toHaveBeenCalled();
    term.selection = "copy this";
    await adapter.copySelection();
    expect(clipboard).toHaveBeenCalledWith("copy this");
    clipboard.mockRejectedValueOnce(new Error("clipboard denied"));
    await expect(adapter.copySelection()).rejects.toThrow("clipboard denied");
  });

  it("disposes once, stops observing and ignores queued observer callbacks", () => {
    const { adapter, term } = createAdapter();
    const { transport, data, close } = createTransport();
    adapter.attach(transport);
    const hover = vi.fn();
    adapter.on("link-hover", hover);
    adapter.dispose();
    adapter.dispose();
    expect(disconnectObserver).toHaveBeenCalledOnce();
    expect(term.dispose).toHaveBeenCalledOnce();
    expect(data.size).toBe(0);
    expect(close.size).toBe(0);
    mocks.fit.mockClear();
    resizeHost();
    expect(mocks.fit).not.toHaveBeenCalled();
    mocks.links.leave?.();
    expect(hover).not.toHaveBeenCalled();
    expect(() => adapter.attach(transport)).toThrow("Terminal has been disposed");
  });
});

import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { XTermPalette } from "@/lib/themes";
import { XTermInstance, type XTermInstanceHandle } from "./XTermInstance";

const mocks = vi.hoisted(() => ({
  focus: vi.fn(),
  blur: vi.fn(),
  write: vi.fn(),
  writeAction: vi.fn(),
  refresh: vi.fn(),
  connect: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  onReady: undefined as ((ptyId: string, cwd: string) => void) | undefined,
  onReconnected: undefined as
    | ((scrollback: string, alive: boolean, cwd: string | null) => void)
    | undefined,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    element: HTMLElement | null = null;
    options: Record<string, unknown> = {};
    textarea: HTMLTextAreaElement | null = null;

    constructor(options: Record<string, unknown>) {
      this.options = options;
    }

    loadAddon(): void {}
    attachCustomKeyEventHandler(): void {}
    onData(): { dispose: () => void } {
      return { dispose: vi.fn() };
    }
    open(container: HTMLElement): void {
      this.element = container;
      this.textarea = document.createElement("textarea");
      container.appendChild(this.textarea);
    }
    focus(): void {
      mocks.focus();
    }
    blur(): void {
      mocks.blur();
    }
    write(data: string): void {
      mocks.write(data);
    }
    refresh(start: number, end: number): void {
      mocks.refresh(start, end);
    }
    dispose(): void {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit(): void {}
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class MockWebLinksAddon {},
}));

vi.mock("@/hooks/useTerminalWebSocket", () => ({
  useTerminalWebSocket: (args: {
    onReady: (ptyId: string, cwd: string) => void;
    onReconnected: (scrollback: string, alive: boolean, cwd: string | null) => void;
  }) => {
    mocks.onReady = args.onReady;
    mocks.onReconnected = args.onReconnected;
    return {
      connect: mocks.connect,
      write: mocks.writeAction,
      resize: mocks.resize,
      kill: mocks.kill,
    };
  },
}));

vi.mock("@/lib/resize-coordinator", () => ({
  isResizing: () => false,
  subscribeResize: () => vi.fn(),
}));

const theme: XTermPalette = {
  foreground: "#fff",
  background: "#000",
  cursor: "#fff",
  cursorAccent: "#000",
  selectionBackground: "#333",
  selectionForeground: "#fff",
  selectionInactiveBackground: "#222",
  black: "#000",
  red: "#f00",
  green: "#0f0",
  yellow: "#ff0",
  blue: "#00f",
  magenta: "#f0f",
  cyan: "#0ff",
  white: "#fff",
  brightBlack: "#111",
  brightRed: "#f66",
  brightGreen: "#6f6",
  brightYellow: "#ff6",
  brightBlue: "#66f",
  brightMagenta: "#f6f",
  brightCyan: "#6ff",
  brightWhite: "#fff",
};

describe("XTermInstance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.onReady = undefined;
    mocks.onReconnected = undefined;
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      value: 600,
    });
    global.ResizeObserver = class MockResizeObserver {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
    global.IntersectionObserver = class MockIntersectionObserver {
      readonly root = null;
      readonly rootMargin = "";
      readonly thresholds = [];
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    } as unknown as typeof IntersectionObserver;
  });

  it("does not focus the terminal when a PTY becomes ready", () => {
    render(<XTermInstance featureId={1} projectId={2} theme={theme} />);

    mocks.onReady?.("pty-1", "/repo");

    expect(mocks.focus).not.toHaveBeenCalled();
  });

  it("does not focus the terminal when reconnecting to a PTY", () => {
    render(<XTermInstance featureId={1} projectId={2} existingPtyId="pty-1" theme={theme} />);

    mocks.onReconnected?.("", true, "/repo");

    expect(mocks.focus).not.toHaveBeenCalled();
  });

  it("exposes an imperative clearScreen method that sends Ctrl+L", () => {
    const write = vi.fn();
    mocks.writeAction = write;
    const ref = { current: null as XTermInstanceHandle | null };
    render(<XTermInstance ref={ref} featureId={1} projectId={2} theme={theme} />);

    ref.current?.clearScreen();

    expect(write).toHaveBeenCalledWith("\x0c");
  });

  it("exposes an imperative clearInput method that deletes the whole current shell line", () => {
    const write = vi.fn();
    mocks.writeAction = write;
    const ref = { current: null as XTermInstanceHandle | null };
    render(<XTermInstance ref={ref} featureId={1} projectId={2} theme={theme} />);

    ref.current?.clearInput();

    expect(write).toHaveBeenCalledWith("\x05\x15");
  });
});

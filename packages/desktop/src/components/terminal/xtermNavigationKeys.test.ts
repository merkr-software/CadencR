import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";

import { attachXtermNavigationKeys } from "./xtermNavigationKeys";

interface TestNavigationRefs {
  exitedRef: { current: boolean };
  ptyIdRef: { current: string | null };
  writeRef: { current: ((data: string) => void) | null };
}

interface MockTerminalResult {
  clearSelection: ReturnType<typeof vi.fn>;
  handler: ((event: KeyboardEvent) => boolean) | null;
  instance: Terminal;
  readText: ReturnType<typeof vi.fn>;
  writeText: ReturnType<typeof vi.fn>;
}

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

describe("attachXtermNavigationKeys", () => {
  beforeEach(() => {
    setPlatform("Linux x86_64");
  });

  afterEach(() => {
    clearDesktopBridgeOverrideForTests();
  });

  it("keeps Linux Ctrl+Shift+C copy in the same xterm key handler as navigation", async () => {
    const terminal = mockTerminal({ selection: "selected text" });
    const refs = navigationRefs();

    attachXtermNavigationKeys(terminal.instance, refs);

    expect(terminal.handler?.(keyboardEvent("C", { ctrlKey: true, shiftKey: true }))).toBe(false);
    await Promise.resolve();

    expect(terminal.writeText).toHaveBeenCalledWith("selected text");
    expect(terminal.clearSelection).toHaveBeenCalledOnce();
    expect(refs.writeRef.current).not.toHaveBeenCalled();
  });

  it("still sends macOS-style navigation sequences after composing clipboard handling", () => {
    const terminal = mockTerminal();
    const refs = navigationRefs();

    attachXtermNavigationKeys(terminal.instance, refs);

    expect(terminal.handler?.(keyboardEvent("ArrowLeft", { metaKey: true }))).toBe(false);

    expect(refs.writeRef.current).toHaveBeenCalledWith("\x01");
  });

  it("consumes Ctrl+Shift+V without reading the clipboard when no PTY is active", async () => {
    const terminal = mockTerminal();
    const refs = navigationRefs();
    refs.ptyIdRef.current = null;

    attachXtermNavigationKeys(terminal.instance, refs);

    expect(terminal.handler?.(keyboardEvent("v", { ctrlKey: true, shiftKey: true }))).toBe(false);
    await Promise.resolve();

    expect(terminal.readText).not.toHaveBeenCalled();
    expect(terminal.instance.paste).not.toHaveBeenCalled();
  });
});

function navigationRefs(): TestNavigationRefs {
  return {
    exitedRef: { current: false },
    ptyIdRef: { current: "pty-1" },
    writeRef: { current: vi.fn<(data: string) => void>() },
  };
}

function setPlatform(platform: string): void {
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value: platform,
  });
}

interface MockTerminalOptions {
  selection?: string;
}

function mockTerminal(options: MockTerminalOptions = {}): MockTerminalResult {
  let handler: ((event: KeyboardEvent) => boolean) | null = null;
  const writeText = vi.fn(() => Promise.resolve());
  const readText = vi.fn(() => Promise.resolve(""));
  setDesktopBridgeOverrideForTests({
    readClipboardText: readText,
    writeClipboardText: writeText,
  });

  const attachCustomKeyEventHandler = vi.fn((next: (event: KeyboardEvent) => boolean): void => {
    handler = next;
  });
  const clearSelection = vi.fn();
  const instance = {
    attachCustomKeyEventHandler,
    clearSelection,
    getSelection: () => options.selection ?? "",
    paste: vi.fn(),
  } as unknown as Terminal;

  return {
    clearSelection,
    get handler(): ((event: KeyboardEvent) => boolean) | null {
      return handler;
    },
    instance,
    readText,
    writeText,
  };
}

function keyboardEvent(
  key: string,
  modifiers: Pick<KeyboardEventInit, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">,
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
}

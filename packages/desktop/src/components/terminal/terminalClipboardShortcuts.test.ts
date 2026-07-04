import type { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";

import { handleLinuxTerminalClipboardShortcut } from "./terminalClipboardShortcuts";

const toastError = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({
  toast: {
    error: toastError,
  },
}));

describe("handleLinuxTerminalClipboardShortcut", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform("Linux x86_64");
  });

  afterEach(() => {
    clearDesktopBridgeOverrideForTests();
  });

  it("ignores Linux clipboard shortcuts on macOS", () => {
    setPlatform("MacIntel");
    const terminal = mockTerminal();

    const result = handleLinuxTerminalClipboardShortcut(
      terminal.instance,
      keyboardEvent("c", { ctrlKey: true, shiftKey: true }),
    );

    expect(result).toBeNull();
    expect(terminal.writeText).not.toHaveBeenCalled();
  });

  it("leaves Ctrl+C alone so xterm can send SIGINT to the PTY", () => {
    const terminal = mockTerminal();

    const event = keyboardEvent("c", { ctrlKey: true });

    expect(handleLinuxTerminalClipboardShortcut(terminal.instance, event)).toBeNull();
    expect(terminal.writeText).not.toHaveBeenCalled();
  });

  it("copies the terminal selection on Ctrl+Shift+C", async () => {
    const terminal = mockTerminal({ selection: "selected text" });

    const event = keyboardEvent("C", { ctrlKey: true, shiftKey: true });
    const preventDefault = vi.spyOn(event, "preventDefault");

    expect(handleLinuxTerminalClipboardShortcut(terminal.instance, event)).toBe(false);
    await Promise.resolve();

    expect(preventDefault).toHaveBeenCalled();
    expect(terminal.writeText).toHaveBeenCalledWith("selected text");
    expect(terminal.clearSelection).toHaveBeenCalledOnce();
  });

  it("pastes clipboard text on Ctrl+Shift+V", async () => {
    const terminal = mockTerminal({ clipboardText: "echo hi" });

    const event = keyboardEvent("v", { ctrlKey: true, shiftKey: true });

    expect(handleLinuxTerminalClipboardShortcut(terminal.instance, event)).toBe(false);
    await Promise.resolve();

    expect(terminal.readText).toHaveBeenCalledOnce();
    expect(terminal.paste).toHaveBeenCalledWith("echo hi");
  });

  it("does not paste when paste is disabled by the composed terminal handler", async () => {
    const terminal = mockTerminal({ clipboardText: "echo hi" });

    expect(
      handleLinuxTerminalClipboardShortcut(
        terminal.instance,
        keyboardEvent("v", { ctrlKey: true, shiftKey: true }),
        { canPaste: false },
      ),
    ).toBe(false);
    await Promise.resolve();

    expect(terminal.readText).not.toHaveBeenCalled();
    expect(terminal.paste).not.toHaveBeenCalled();
  });

  it("consumes repeated clipboard shortcuts without repeating clipboard work", async () => {
    const terminal = mockTerminal({ clipboardText: "echo hi" });

    expect(
      handleLinuxTerminalClipboardShortcut(
        terminal.instance,
        keyboardEvent("v", { ctrlKey: true, shiftKey: true, repeat: true }),
      ),
    ).toBe(false);
    await Promise.resolve();

    expect(terminal.readText).not.toHaveBeenCalled();
    expect(terminal.paste).not.toHaveBeenCalled();
  });

  it("surfaces clipboard failures to the user", async () => {
    const terminal = mockTerminal({ writeError: new Error("denied"), selection: "selected text" });

    expect(
      handleLinuxTerminalClipboardShortcut(
        terminal.instance,
        keyboardEvent("c", { ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(false);
    await Promise.resolve();

    expect(toastError).toHaveBeenCalledWith("Failed to copy terminal selection");
  });

  it("surfaces native clipboard read failures to the user", async () => {
    const terminal = mockTerminal({ readError: new Error("denied") });

    expect(
      handleLinuxTerminalClipboardShortcut(
        terminal.instance,
        keyboardEvent("v", { ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(false);
    await Promise.resolve();

    expect(toastError).toHaveBeenCalledWith("Failed to paste into terminal");
    expect(terminal.paste).not.toHaveBeenCalled();
  });
});

function setPlatform(platform: string): void {
  Object.defineProperty(window.navigator, "platform", {
    configurable: true,
    value: platform,
  });
}

interface MockTerminalOptions {
  clipboardText?: string;
  readError?: Error;
  selection?: string;
  writeError?: Error;
}

function mockTerminal(options: MockTerminalOptions = {}) {
  const readText = vi.fn(() =>
    options.readError
      ? Promise.reject(options.readError)
      : Promise.resolve(options.clipboardText ?? ""),
  );
  const writeText = vi.fn(() =>
    options.writeError ? Promise.reject(options.writeError) : Promise.resolve(),
  );
  setDesktopBridgeOverrideForTests({
    readClipboardText: readText,
    writeClipboardText: writeText,
  });

  const clearSelection = vi.fn();
  const paste = vi.fn();
  const instance = {
    clearSelection,
    getSelection: () => options.selection ?? "",
    paste,
  } as unknown as Terminal;

  return {
    clearSelection,
    instance,
    paste,
    readText,
    writeText,
  };
}

function keyboardEvent(
  key: string,
  modifiers: Pick<KeyboardEventInit, "altKey" | "ctrlKey" | "metaKey" | "repeat" | "shiftKey">,
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
}

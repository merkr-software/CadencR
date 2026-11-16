// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { isShellControlChord, shellOwnsKeyEvent } from "./shell-keys";

function keydown(init: KeyboardEventInit, target?: Element): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, ...init });
  if (target) Object.defineProperty(event, "target", { value: target });
  return event;
}

function terminalTarget(): Element {
  const zone = document.createElement("div");
  zone.dataset.focusZone = "terminal";
  const input = document.createElement("textarea");
  zone.append(input);
  document.body.append(zone);
  return input;
}

afterEach(() => document.body.replaceChildren());

describe("isShellControlChord", () => {
  it.each([
    ["Ctrl+D", { key: "d", code: "KeyD" }],
    ["Ctrl+W", { key: "w", code: "KeyW" }],
    ["Ctrl+R", { key: "r", code: "KeyR" }],
    ["Ctrl+J as a control character", { key: "\n", code: "KeyJ" }],
    ["Ctrl+A on AZERTY", { key: "a", code: "KeyQ" }],
    ["Ctrl+С on a Cyrillic layout", { key: "с", code: "KeyC" }],
    ["Ctrl+[ (Escape)", { key: "[", code: "BracketLeft" }],
    ["Ctrl+Backspace", { key: "Backspace", code: "Backspace" }],
  ])("reserves %s for the shell off macOS", (_label, init) => {
    expect(isShellControlChord(keydown({ ...init, ctrlKey: true }), false)).toBe(true);
  });

  it.each([
    ["Ctrl+Shift+C", { key: "C", code: "KeyC", ctrlKey: true, shiftKey: true }],
    ["Ctrl+Alt+K", { key: "k", code: "KeyK", ctrlKey: true, altKey: true }],
    ["Ctrl+Plus", { key: "+", code: "Equal", ctrlKey: true }],
    ["Ctrl+Comma", { key: ",", code: "Comma", ctrlKey: true }],
    ["plain D", { key: "d", code: "KeyD" }],
  ])("leaves %s to app shortcuts off macOS", (_label, init) => {
    expect(isShellControlChord(keydown(init), false)).toBe(false);
  });

  it("reserves nothing on macOS, whose app shortcuts use Cmd", () => {
    expect(isShellControlChord(keydown({ key: "d", code: "KeyD", ctrlKey: true }), true)).toBe(
      false,
    );
  });
});

describe("shellOwnsKeyEvent", () => {
  it("applies only while the terminal has focus", () => {
    const outside = document.createElement("textarea");
    document.body.append(outside);
    const init = { key: "d", code: "KeyD", ctrlKey: true };

    expect(shellOwnsKeyEvent(keydown(init, terminalTarget()), false)).toBe(true);
    expect(shellOwnsKeyEvent(keydown(init, outside), false)).toBe(false);
    expect(shellOwnsKeyEvent(keydown(init, terminalTarget()), true)).toBe(false);
  });
});

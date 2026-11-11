import type { KeyboardEvent } from "react";
import { describe, expect, it } from "vitest";
import { pressedDigit } from "./gate-keys";

function press(key: string, code: string, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    nativeEvent: { isComposing: false },
    ...modifiers,
  } as KeyboardEvent;
}

describe("pressedDigit", () => {
  it("reads the digit row by its code, so AZERTY's `&` is a 1", () => {
    expect(pressedDigit(press("&", "Digit1"))).toBe(1);
    expect(pressedDigit(press("3", "Digit3"))).toBe(3);
  });

  it("reads the numpad when it types a digit", () => {
    expect(pressedDigit(press("2", "Numpad2"))).toBe(2);
  });

  it("ignores the numpad with NumLock off, where its keys navigate", () => {
    expect(pressedDigit(press("End", "Numpad1"))).toBeNull();
    expect(pressedDigit(press("ArrowDown", "Numpad2"))).toBeNull();
  });

  it("ignores zero, other keys and any modifier but Shift", () => {
    expect(pressedDigit(press("0", "Digit0"))).toBeNull();
    expect(pressedDigit(press("a", "KeyA"))).toBeNull();
    expect(pressedDigit(press("1", "Digit1", { metaKey: true }))).toBeNull();
  });
});

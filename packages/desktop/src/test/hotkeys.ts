import { parseHotkey, type Hotkey, type HotkeyCallback } from "@tanstack/hotkeys";

/** Invoke a mocked registration with the event and context the engine supplies. */
export function invokeRegisteredHotkey(
  callback: HotkeyCallback,
  hotkey: string,
  overrides: Partial<KeyboardEvent> = {},
): void {
  const parsedHotkey = parseHotkey(hotkey);
  const event = new KeyboardEvent("keydown", {
    key: overrides.key ?? parsedHotkey.key,
    code: overrides.code ?? parsedHotkey.code,
    ctrlKey: overrides.ctrlKey ?? parsedHotkey.ctrl,
    shiftKey: overrides.shiftKey ?? parsedHotkey.shift,
    altKey: overrides.altKey ?? parsedHotkey.alt,
    metaKey: overrides.metaKey ?? parsedHotkey.meta,
    isComposing: overrides.isComposing,
    repeat: overrides.repeat,
    location: overrides.location,
    bubbles: true,
    cancelable: true,
  });
  // Preserve the assertions attached to event-method spies in component tests.
  for (const method of ["preventDefault", "stopPropagation"] as const) {
    if (overrides[method]) Object.defineProperty(event, method, { value: overrides[method] });
  }
  callback(event, { hotkey: hotkey as Hotkey, parsedHotkey });
}

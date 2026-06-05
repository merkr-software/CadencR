/**
 * Focus-target predicates used to gate app-level shortcuts that share a
 * chord with a CodeMirror buffer binding (Mod+Shift+L, Mod+Shift+K,
 * Mod+Alt+ArrowUp/Down). The buffer keymap is mounted at `Prec.highest`
 * and intercepts these chords while the editor has focus, but the
 * `useShortcut` engine also fires its callbacks — these helpers let
 * app-level handlers no-op when focus is inside the editor so the buffer
 * action is the only thing that runs.
 *
 * Cheap (single DOM walk on the active element's ancestors); safe to call
 * from a shortcut callback.
 */
export function isInCodeMirrorEditor(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".cm-editor") !== null;
}

export function isInTerminalFocusZone(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-focus-zone="terminal"]') !== null;
}

import { Emitter } from "./emitter.js";
import type { EditorAppearance, HelloResult } from "./protocol.js";

/** State refreshed on every handshake, including a hidden guest's recreation. */
export class SurfaceState {
  focused = false;
  appearance: EditorAppearance | null = null;
  readonly focusChanges = new Emitter<boolean>();
  readonly appearanceChanges = new Emitter<EditorAppearance>();

  ready(hello: HelloResult): void {
    this.setFocused(hello.focused ?? false);
    if (hello.editorAppearance) this.setAppearance(hello.editorAppearance);
    else this.appearance = null;
  }

  setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    this.focusChanges.emit(focused);
  }

  setAppearance(appearance: EditorAppearance): void {
    if (
      this.appearance?.fontFamily === appearance.fontFamily &&
      this.appearance.fontSize === appearance.fontSize
    )
      return;
    this.appearance = appearance;
    this.appearanceChanges.emit(appearance);
  }

  clear(): void {
    this.focusChanges.clear();
    this.appearanceChanges.clear();
  }
}

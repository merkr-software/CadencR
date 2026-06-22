import { renderHook } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useGlobalShortcut } from "./useGlobalShortcut";

function fireKey(key: string, opts: Partial<KeyboardEventInit> = {}) {
  const event = new KeyboardEvent("keydown", {
    key,
    code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  window.dispatchEvent(event);
  return event;
}

describe("useGlobalShortcut", () => {
  let callback: ReturnType<typeof vi.fn<(e: KeyboardEvent) => void>>;

  beforeEach(() => {
    callback = vi.fn<(e: KeyboardEvent) => void>();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires callback on matching meta+key shortcut", () => {
    renderHook(() => useGlobalShortcut("meta+p", callback));
    fireKey("p", { metaKey: true, code: "KeyP" });
    expect(callback).toHaveBeenCalledOnce();
  });

  it("does not fire when modifier is missing", () => {
    renderHook(() => useGlobalShortcut("meta+p", callback));
    fireKey("p", { code: "KeyP" });
    expect(callback).not.toHaveBeenCalled();
  });

  it("does not fire when wrong modifier is pressed", () => {
    renderHook(() => useGlobalShortcut("meta+p", callback));
    fireKey("p", { ctrlKey: true, code: "KeyP" });
    expect(callback).not.toHaveBeenCalled();
  });

  it("does not fire when extra modifier is pressed", () => {
    renderHook(() => useGlobalShortcut("meta+p", callback));
    fireKey("p", { metaKey: true, shiftKey: true, code: "KeyP" });
    expect(callback).not.toHaveBeenCalled();
  });

  it("handles meta+shift+key", () => {
    renderHook(() => useGlobalShortcut("meta+shift+m", callback));
    fireKey("M", { metaKey: true, shiftKey: true, code: "KeyM" });
    expect(callback).toHaveBeenCalledOnce();
  });

  it("handles TanStack Mod+Shift+letter syntax on AZERTY by labelled key", () => {
    renderHook(() => useGlobalShortcut("Mod+Shift+A", callback));
    fireKey("A", { metaKey: true, shiftKey: true, code: "KeyQ" });
    expect(callback).toHaveBeenCalledOnce();
  });

  it("handles ctrl+key using e.code for letters", () => {
    // ctrl+j produces a control character for e.key, but e.code stays KeyJ
    renderHook(() => useGlobalShortcut("ctrl+j", callback));
    fireKey("\n", { ctrlKey: true, code: "KeyJ" });
    expect(callback).toHaveBeenCalledOnce();
  });

  it("handles meta+enter (non-letter key)", () => {
    renderHook(() => useGlobalShortcut("meta+enter", callback));
    fireKey("Enter", { metaKey: true, code: "Enter" });
    expect(callback).toHaveBeenCalledOnce();
  });

  it("handles meta+shift+? (symbol key)", () => {
    renderHook(() => useGlobalShortcut("meta+shift+?", callback));
    fireKey("?", { metaKey: true, shiftKey: true, code: "Slash" });
    expect(callback).toHaveBeenCalledOnce();
  });

  it("handles meta+? by exact character even when Shift produces it", () => {
    renderHook(() => useGlobalShortcut("meta+?", callback));
    fireKey("?", { metaKey: true, shiftKey: true, code: "Slash" });
    expect(callback).toHaveBeenCalledOnce();
  });

  it("does not treat AZERTY plus on physical Slash as Mod+/", () => {
    renderHook(() => useGlobalShortcut("Mod+/", callback));
    fireKey("+", { metaKey: true, code: "Slash" });
    expect(callback).not.toHaveBeenCalled();
  });

  it("handles digit keys", () => {
    renderHook(() => useGlobalShortcut("meta+1", callback));
    fireKey("1", { metaKey: true, code: "Digit1" });
    expect(callback).toHaveBeenCalledOnce();
  });

  it("handles digit characters that require Shift without accepting shifted symbols", () => {
    renderHook(() => useGlobalShortcut("meta+1", callback));

    fireKey("!", { metaKey: true, shiftKey: true, code: "Digit1" });
    expect(callback).not.toHaveBeenCalled();

    fireKey("1", { metaKey: true, shiftKey: true, code: "Digit1" });
    expect(callback).toHaveBeenCalledOnce();
  });

  // Regression: GitHub issue #2. All letter shortcuts must respect the
  // user's keyboard layout, not the physical QWERTY key position. On
  // AZERTY the labelled "A" key sits where Q is on QWERTY (e.code ===
  // "KeyQ" while e.key === "a"); on QWERTZ "Y" sits where Z is.
  describe("non-QWERTY layouts", () => {
    it.each([
      // AZERTY: labelled "A" key (physical KeyQ).
      {
        name: "AZERTY cmd+a fires on labelled A",
        binding: "meta+a",
        key: "a",
        code: "KeyQ",
        shift: false,
        shouldFire: true,
      },
      {
        name: "AZERTY cmd+q does NOT fire on labelled A",
        binding: "meta+q",
        key: "a",
        code: "KeyQ",
        shift: false,
        shouldFire: false,
      },
      // AZERTY: labelled "Q" key (physical KeyA).
      {
        name: "AZERTY cmd+q fires on labelled Q",
        binding: "meta+q",
        key: "q",
        code: "KeyA",
        shift: false,
        shouldFire: true,
      },
      // QWERTZ: labelled "Y" key (physical KeyZ).
      {
        name: "QWERTZ cmd+y fires on labelled Y",
        binding: "meta+y",
        key: "y",
        code: "KeyZ",
        shift: false,
        shouldFire: true,
      },
      {
        name: "QWERTZ cmd+z does NOT fire on labelled Y",
        binding: "meta+z",
        key: "y",
        code: "KeyZ",
        shift: false,
        shouldFire: false,
      },
      // Uppercase e.key when Shift is held.
      {
        name: "AZERTY cmd+shift+a fires on labelled A",
        binding: "meta+shift+a",
        key: "A",
        code: "KeyQ",
        shift: true,
        shouldFire: true,
      },
      // Find-in-conversation (⌘F): Dvorak puts the labelled "F" key where
      // QWERTY's "Y" is, so e.code === "KeyY" while e.key === "f". The bar
      // must still open from the labelled F.
      {
        name: "Dvorak cmd+f fires find-in-conversation on labelled F",
        binding: "meta+f",
        key: "f",
        code: "KeyY",
        shift: false,
        shouldFire: true,
      },
    ])("$name", ({ binding, key, code, shift, shouldFire }) => {
      renderHook(() => useGlobalShortcut(binding, callback));
      fireKey(key, { metaKey: true, shiftKey: shift, code });
      if (shouldFire) expect(callback).toHaveBeenCalledOnce();
      else expect(callback).not.toHaveBeenCalled();
    });
  });

  it("handles meta+shift+] via e.code (shift turns ] into })", () => {
    renderHook(() => useGlobalShortcut("meta+shift+]", callback));
    // On macOS, Shift+] produces e.key === "}" but e.code stays "BracketRight"
    fireKey("}", { metaKey: true, shiftKey: true, code: "BracketRight" });
    expect(callback).toHaveBeenCalledOnce();
  });

  it("handles meta+shift+[ via e.code (shift turns [ into {)", () => {
    renderHook(() => useGlobalShortcut("meta+shift+[", callback));
    fireKey("{", { metaKey: true, shiftKey: true, code: "BracketLeft" });
    expect(callback).toHaveBeenCalledOnce();
  });

  it("does not fire bracket shortcut without shift", () => {
    renderHook(() => useGlobalShortcut("meta+shift+]", callback));
    fireKey("]", { metaKey: true, code: "BracketRight" });
    expect(callback).not.toHaveBeenCalled();
  });

  it("does not fire when enabled is false", () => {
    renderHook(() => useGlobalShortcut("meta+p", callback, { enabled: false }));
    fireKey("p", { metaKey: true, code: "KeyP" });
    expect(callback).not.toHaveBeenCalled();
  });

  it("re-attaches listener when enabled changes to true", () => {
    const { rerender } = renderHook(
      ({ enabled }) => useGlobalShortcut("meta+p", callback, { enabled }),
      { initialProps: { enabled: false } },
    );
    fireKey("p", { metaKey: true, code: "KeyP" });
    expect(callback).not.toHaveBeenCalled();

    rerender({ enabled: true });
    fireKey("p", { metaKey: true, code: "KeyP" });
    expect(callback).toHaveBeenCalledOnce();
  });

  it("cleans up listener on unmount", () => {
    const { unmount } = renderHook(() => useGlobalShortcut("meta+p", callback));
    unmount();
    fireKey("p", { metaKey: true, code: "KeyP" });
    expect(callback).not.toHaveBeenCalled();
  });

  it("uses latest callback without re-attaching listener", () => {
    const cb1 = vi.fn<(e: KeyboardEvent) => void>();
    const cb2 = vi.fn<(e: KeyboardEvent) => void>();
    const { rerender } = renderHook(({ cb }) => useGlobalShortcut("meta+p", cb), {
      initialProps: { cb: cb1 },
    });
    rerender({ cb: cb2 });
    fireKey("p", { metaKey: true, code: "KeyP" });
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledOnce();
  });

  it("passes the KeyboardEvent to callback", () => {
    renderHook(() => useGlobalShortcut("meta+s", callback));
    fireKey("s", { metaKey: true, code: "KeyS" });
    expect(callback).toHaveBeenCalledWith(expect.any(KeyboardEvent));
  });

  // Regression: arrow keys arrive as `ArrowLeft`/`ArrowRight` etc. on
  // KeyboardEvent.key, but callers spell shortcuts as "meta+alt+left". The
  // matcher must alias both spellings to KeyboardEvent.code so terminal
  // split-navigation works.
  describe("arrow key aliases", () => {
    const cases: Array<[string, string]> = [
      ["meta+alt+left", "ArrowLeft"],
      ["meta+alt+right", "ArrowRight"],
      ["meta+alt+up", "ArrowUp"],
      ["meta+alt+down", "ArrowDown"],
    ];

    for (const [shortcut, code] of cases) {
      it(`matches ${shortcut} via short alias`, () => {
        renderHook(() => useGlobalShortcut(shortcut, callback));
        fireKey(code, { metaKey: true, altKey: true, code });
        expect(callback).toHaveBeenCalledOnce();
      });
    }

    it("also accepts the long Arrow… spelling", () => {
      renderHook(() => useGlobalShortcut("meta+alt+arrowleft", callback));
      fireKey("ArrowLeft", { metaKey: true, altKey: true, code: "ArrowLeft" });
      expect(callback).toHaveBeenCalledOnce();
    });

    it("ignores arrow key without the expected modifiers", () => {
      renderHook(() => useGlobalShortcut("meta+alt+left", callback));
      fireKey("ArrowLeft", { metaKey: true, code: "ArrowLeft" });
      expect(callback).not.toHaveBeenCalled();
    });
  });
});

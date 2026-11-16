import { describe, expect, it } from "vitest";

import { parseBrowserGuestShortcutBindings } from "./browser-guest-shortcuts";

describe("parseBrowserGuestShortcutBindings", () => {
  it("accepts projected registry bindings and blank disabled chords", () => {
    expect(
      parseBrowserGuestShortcutBindings({
        find: { keys: ["mod", "f"] },
        downloads: { keys: ["mod", "shift", "j"] },
        responsive: { keys: ["mod", "shift", "m"] },
        devtools: { keys: ["mod", "alt", "i"] },
        zoomReset: { keys: [], altKeys: [] },
        navigateBack: { keys: ["mod", "lbracket"] },
        navigateForward: { keys: ["mod", "rbracket"] },
      }),
    ).toEqual({
      find: { keys: ["mod", "f"] },
      downloads: { keys: ["mod", "shift", "j"] },
      responsive: { keys: ["mod", "shift", "m"] },
      devtools: { keys: ["mod", "alt", "i"] },
      zoomReset: { keys: [], altKeys: [] },
      navigateBack: { keys: ["mod", "lbracket"] },
      navigateForward: { keys: ["mod", "rbracket"] },
    });
  });

  it("rejects unprojected registry metadata and chords without exactly one key", () => {
    expect(() =>
      parseBrowserGuestShortcutBindings({
        find: { id: "browser-find", keys: ["mod", "f"] },
        downloads: { keys: ["mod", "shift", "j"] },
        responsive: { keys: ["mod", "shift", "m"] },
        devtools: { keys: ["mod", "alt", "i"] },
        zoomReset: { keys: ["mod", "0"] },
        navigateBack: { keys: ["mod", "lbracket"] },
        navigateForward: { keys: ["mod", "rbracket"] },
      }),
    ).toThrow();
    expect(() =>
      parseBrowserGuestShortcutBindings({
        find: { keys: ["mod"] },
        downloads: { keys: ["mod", "shift", "j"] },
        responsive: { keys: ["mod", "shift", "m"] },
        devtools: { keys: ["mod", "alt", "i"] },
        zoomReset: { keys: ["mod", "0", "x"] },
        navigateBack: { keys: ["mod", "lbracket"] },
        navigateForward: { keys: ["mod", "rbracket"] },
      }),
    ).toThrow();
  });
});

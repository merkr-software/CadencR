import { describe, expect, it } from "vitest";
import { previewCloseKey } from "./preview-shortcut";

const message = {
  type: "cadencr-preview-shortcut",
  shortcut: "editor-close",
  key: "w",
  code: "KeyW",
  metaKey: true,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
};

describe("preview close bridge", () => {
  it.each([
    { ...message, key: "k" },
    { ...message, key: "Enter" },
    { ...message, shiftKey: true },
    { ...message, altKey: true },
    { ...message, metaKey: false },
    { ...message, ctrlKey: true },
    { ...message, metaKey: "true" },
    { ...message, shortcut: "delete-project" },
    { ...message, unexpected: "field" },
    null,
  ])("rejects invalid or arbitrary host shortcut message %j", (invalid) => {
    expect(previewCloseKey(invalid)).toBeNull();
  });

  it("normalizes a labelled W from a non-QWERTY physical key to only the close chord", () => {
    expect(previewCloseKey({ ...message, code: "KeyZ" })).toEqual({
      key: "w",
      code: "KeyW",
      metaKey: true,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    });
    expect(previewCloseKey({ ...message, metaKey: false, ctrlKey: true })).toMatchObject({
      key: "w",
      ctrlKey: true,
    });
  });
});

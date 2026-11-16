import { describe, expect, it } from "vitest";
import { parseNotchPrefs } from "./notch-prefs";

describe("parseNotchPrefs", () => {
  it("defaults to always on with a still logo", () => {
    expect(parseNotchPrefs({ alwaysOn: undefined, alwaysAnimate: "" })).toEqual({
      displayMode: "builtin_always",
      primaryStyle: "strip_8",
      alwaysOn: true,
      alwaysAnimate: false,
    });
  });

  it("honors explicit values", () => {
    expect(parseNotchPrefs({ alwaysOn: "false", alwaysAnimate: "true" })).toEqual({
      displayMode: "builtin_always",
      primaryStyle: "strip_8",
      alwaysOn: false,
      alwaysAnimate: true,
    });
  });

  it.each(["builtin_always", "both", "primary"])("honors the %s display mode", (displayMode) => {
    expect(parseNotchPrefs({ displayMode, alwaysOn: null, alwaysAnimate: null }).displayMode).toBe(
      displayMode,
    );
  });

  it("falls back to the built-in display for an invalid stored mode", () => {
    expect(
      parseNotchPrefs({ displayMode: "all", alwaysOn: null, alwaysAnimate: null }).displayMode,
    ).toBe("builtin_always");
  });

  it.each(["none", "strip_4", "strip_8", "builtin"])(
    "honors the %s primary status style",
    (primaryStyle) => {
      expect(
        parseNotchPrefs({ primaryStyle, alwaysOn: null, alwaysAnimate: null }).primaryStyle,
      ).toBe(primaryStyle);
    },
  );

  it("preserves the 8px strip when the primary style is missing or invalid", () => {
    expect(
      parseNotchPrefs({ primaryStyle: "strip_5", alwaysOn: null, alwaysAnimate: null })
        .primaryStyle,
    ).toBe("strip_8");
  });
});

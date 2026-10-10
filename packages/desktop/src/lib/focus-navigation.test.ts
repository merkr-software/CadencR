// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { focusFollowedKeyboardNavigation, noteFocusNavigationKey } from "./focus-navigation";

function keydown(init: KeyboardEventInit): void {
  noteFocusNavigationKey(new KeyboardEvent("keydown", init));
}

describe("focusFollowedKeyboardNavigation", () => {
  // Reading consumes the recorded intent, which is also how a case resets the
  // module-level state for the next one.
  beforeEach(() => {
    focusFollowedKeyboardNavigation();
  });

  it("is false before the user has pressed anything", () => {
    expect(focusFollowedKeyboardNavigation()).toBe(false);
  });

  it("is true right after a focus-moving key", () => {
    keydown({ key: "Tab" });
    expect(focusFollowedKeyboardNavigation()).toBe(true);

    keydown({ key: "ArrowRight" });
    expect(focusFollowedKeyboardNavigation()).toBe(true);
  });

  it("ignores plain typing", () => {
    keydown({ key: "g" });
    expect(focusFollowedKeyboardNavigation()).toBe(false);
  });

  it("ignores modified keys, so a pane shortcut's focus side effect doesn't count", () => {
    keydown({ key: "Tab", metaKey: true });
    expect(focusFollowedKeyboardNavigation()).toBe(false);

    keydown({ key: "ArrowDown", altKey: true });
    expect(focusFollowedKeyboardNavigation()).toBe(false);
  });

  it("counts Shift+Tab but not shifted arrows, which extend a selection", () => {
    keydown({ key: "Tab", shiftKey: true });
    expect(focusFollowedKeyboardNavigation()).toBe(true);

    keydown({ key: "ArrowRight", shiftKey: true });
    expect(focusFollowedKeyboardNavigation()).toBe(false);

    keydown({ key: "Home", shiftKey: true });
    expect(focusFollowedKeyboardNavigation()).toBe(false);
  });

  it("spends the intent on the first focus only", () => {
    keydown({ key: "Tab" });

    expect(focusFollowedKeyboardNavigation()).toBe(true);
    // A later programmatic focus inside the same window can't reuse it.
    expect(focusFollowedKeyboardNavigation()).toBe(false);
  });
});

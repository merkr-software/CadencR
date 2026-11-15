import { describe, expect, it } from "vitest";
import { BrowserScopeErrors } from "./browser-scope-errors";

describe("BrowserScopeErrors", () => {
  it("shows a tab's error only while that tab is the feature's active one", () => {
    const errors = new BrowserScopeErrors();
    errors.report(1, "tab failed", "a");
    expect(errors.get(1, "a")).toBe("tab failed");
    expect(errors.get(1, "b")).toBeNull();
    expect(errors.get(2, "a")).toBeNull();
    expect(errors.get(1, null)).toBeNull();
  });

  it("puts a scope-wide error on every tab until a navigation in that feature", () => {
    const errors = new BrowserScopeErrors();
    errors.report(1, "tab failed", "a");
    errors.report(1, "could not save tabs");
    expect(errors.get(1, "a")).toBe("could not save tabs");
    expect(errors.get(1, "b")).toBe("could not save tabs");

    errors.clearForNavigation(1, "b");
    expect(errors.get(1, "b")).toBeNull();
    expect(errors.get(1, "a")).toBe("tab failed");
  });

  it("forgets a closed tab's error and everything of a closed feature", () => {
    const errors = new BrowserScopeErrors();
    errors.report(1, "tab failed", "a");
    errors.releaseTab("a");
    expect(errors.report(1, "tab failed", "a")).toBe(true);

    errors.report(1, "could not save tabs");
    errors.report(2, "other feature", "c");
    errors.clearScope(1);
    expect(errors.get(1, "a")).toBeNull();
    expect(errors.get(2, "c")).toBe("other feature");
  });

  it("reports a repeated failure as unchanged", () => {
    const errors = new BrowserScopeErrors();
    expect(errors.report(1, "same", "a")).toBe(true);
    expect(errors.report(1, "same", "a")).toBe(false);
    expect(errors.report(1, "scope")).toBe(true);
    expect(errors.report(1, "scope")).toBe(false);
  });
});

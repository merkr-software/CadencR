import { describe, expect, it } from "vitest";
import { BrowserScopeErrors } from "./browser-scope-errors";
import type { BrowserTabError } from "./browser-types";

function tabError(overrides: Partial<BrowserTabError> = {}): BrowserTabError {
  return {
    kind: "load",
    title: "Site not found",
    description: "Check the address for typos (missing.invalid).",
    url: "https://missing.invalid/",
    code: "ERR_NAME_NOT_RESOLVED",
    retryable: true,
    ...overrides,
  };
}

describe("BrowserScopeErrors", () => {
  it("shows a tab's structured error only while that tab is active in its scope", () => {
    const errors = new BrowserScopeErrors();
    const err = tabError();
    expect(errors.reportTab(1, "a", err)).toBe(true);
    expect(errors.getTabError(1, "a")).toEqual(err);
    expect(errors.tabErrorFor("a")).toEqual(err);
    expect(errors.tabErrorFor("missing")).toBeNull();
    expect(errors.hasViewportPageError("a")).toBe(true);
    expect(errors.hasViewportPageError("b")).toBe(false);
    expect(errors.getTabError(1, "b")).toBeNull();
    expect(errors.getTabError(2, "a")).toBeNull();
    expect(errors.getTabError(1, null)).toBeNull();
    expect(errors.getTabError(undefined, "a")).toBeNull();
    expect(errors.get(1)).toBeNull();
  });

  it("keeps scope-wide errors separate from per-tab errors", () => {
    const errors = new BrowserScopeErrors();
    expect(
      errors.reportTab(1, "a", {
        kind: "internal",
        title: "Browser error",
        description: "tab failed",
        retryable: false,
      }),
    ).toBe(true);
    expect(errors.report(1, "could not save tabs")).toBe(true);

    expect(errors.get(1)).toBe("could not save tabs");
    expect(errors.get(undefined)).toBeNull();
    expect(errors.hasViewportPageError("a")).toBe(false);
    expect(errors.getTabError(1, "a")).toEqual({
      kind: "internal",
      title: "Browser error",
      description: "tab failed",
      retryable: false,
    });

    expect(errors.clearForNavigation(1, "b")).toBe(true);
    expect(errors.clearForNavigation(1, "b")).toBe(false);
    expect(errors.get(1)).toBeNull();
    expect(errors.getTabError(1, "a")?.description).toBe("tab failed");
  });

  it("forgets a closed tab's error and everything of a closed feature", () => {
    const errors = new BrowserScopeErrors();
    const internal = tabError({ kind: "internal", description: "tab failed" });
    errors.reportTab(1, "a", internal);
    expect(errors.releaseTab("a")).toBe(true);
    expect(errors.releaseTab("a")).toBe(false);
    expect(errors.reportTab(1, "a", internal)).toBe(true);

    errors.report(1, "could not save tabs");
    errors.reportTab(2, "c", tabError({ kind: "internal", description: "other feature" }));
    expect(errors.clearScope(1)).toBe(true);
    expect(errors.clearScope(1)).toBe(false);
    expect(errors.get(1)).toBeNull();
    expect(errors.getTabError(1, "a")).toBeNull();
    expect(errors.getTabError(2, "c")?.description).toBe("other feature");
  });

  it("deduplicates identical scope and structured tab errors", () => {
    const errors = new BrowserScopeErrors();
    expect(errors.reportTab(1, "a", tabError())).toBe(true);
    expect(errors.reportTab(1, "a", tabError())).toBe(false);
    expect(errors.reportTab(1, "a", tabError({ code: "ERR_TIMED_OUT" }))).toBe(true);

    expect(errors.report(1, "scope")).toBe(true);
    expect(errors.report(1, "scope")).toBe(false);
  });

  it("dismisses scope-wide and tab errors independently without crossing scopes", () => {
    const errors = new BrowserScopeErrors();
    errors.report(1, "scope notice");
    errors.reportTab(1, "a", tabError());
    errors.reportTab(2, "b", tabError({ url: "https://other.invalid/" }));

    // Wrong scope for tab b does not clear tab b or scope 1's notice.
    expect(errors.dismiss(1, "b")).toBe(false);
    expect(errors.get(1)).toBe("scope notice");
    expect(errors.getTabError(2, "b")).not.toBeNull();

    // Dismissing tab a leaves scope 1's notice intact.
    expect(errors.dismiss(1, "a")).toBe(true);
    expect(errors.getTabError(1, "a")).toBeNull();
    expect(errors.get(1)).toBe("scope notice");
    expect(errors.dismiss(1, "a")).toBe(false);

    // Re-add tab a error, then dismiss scope notice without touching tab a.
    errors.reportTab(1, "a", tabError());
    expect(errors.dismiss(1)).toBe(true);
    expect(errors.get(1)).toBeNull();
    expect(errors.getTabError(1, "a")).not.toBeNull();
    expect(errors.dismiss(1, null)).toBe(false);
  });
});

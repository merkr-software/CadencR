import { describe, expect, it } from "vitest";
import { closeFeatureActivityNoun } from "./feature-activity-close";

describe("closeFeatureActivityNoun", () => {
  it("names both kinds when terminals and browsers are open", () => {
    expect(closeFeatureActivityNoun(2, 3)).toBe("terminals & browsers");
  });

  it("pluralizes terminals by count", () => {
    expect(closeFeatureActivityNoun(1, 0)).toBe("terminal");
    expect(closeFeatureActivityNoun(2, 0)).toBe("terminals");
  });

  it("pluralizes browser tabs by count", () => {
    expect(closeFeatureActivityNoun(0, 1)).toBe("browser tab");
    expect(closeFeatureActivityNoun(0, 4)).toBe("browser tabs");
  });
});

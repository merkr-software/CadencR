import { describe, expect, it } from "vitest";
import { keepsOwnCsp } from "./visual-frame-csp";

const SHELL = "http://127.0.0.1:5004/visual-frame";

describe("keepsOwnCsp", () => {
  it("keeps the CSP of the visual shell loaded as a subframe", () => {
    expect(keepsOwnCsp({ url: SHELL, resourceType: "subFrame" })).toBe(true);
  });

  it("overrides everything else", () => {
    expect(keepsOwnCsp({ url: SHELL, resourceType: "mainFrame" })).toBe(false);
    expect(keepsOwnCsp({ url: SHELL, resourceType: "xhr" })).toBe(false);
    expect(
      keepsOwnCsp({ url: "http://127.0.0.1:5004/visual-frame/x", resourceType: "subFrame" }),
    ).toBe(false);
    expect(keepsOwnCsp({ url: "file:///visual-frame", resourceType: "subFrame" })).toBe(false);
    expect(keepsOwnCsp({ url: "not a url", resourceType: "subFrame" })).toBe(false);
  });
});

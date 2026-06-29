import { afterEach, describe, expect, it } from "vitest";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "./desktop-bridge";
import {
  DEFAULT_INTERNAL_DOMAINS,
  matchesInternalDomain,
  parseInternalDomains,
  resolveTarget,
  serializeInternalDomains,
} from "./link-routing";

describe("parseInternalDomains", () => {
  it("falls back to defaults when unset or malformed", () => {
    expect(parseInternalDomains(null)).toEqual([...DEFAULT_INTERNAL_DOMAINS]);
    expect(parseInternalDomains("")).toEqual([...DEFAULT_INTERNAL_DOMAINS]);
    expect(parseInternalDomains("not json")).toEqual([...DEFAULT_INTERNAL_DOMAINS]);
    expect(parseInternalDomains("{}")).toEqual([...DEFAULT_INTERNAL_DOMAINS]);
  });

  it("parses a stored list and keeps an explicit empty list", () => {
    expect(parseInternalDomains('["localhost","example.com"]')).toEqual([
      "localhost",
      "example.com",
    ]);
    // Removing every domain is a real choice — don't resurrect the defaults.
    expect(parseInternalDomains("[]")).toEqual([]);
  });

  it("drops non-string entries", () => {
    expect(parseInternalDomains('["a",1,null,"b"]')).toEqual(["a", "b"]);
  });

  it("round-trips through serialize", () => {
    const domains = ["localhost", "dev.test"];
    expect(parseInternalDomains(serializeInternalDomains(domains))).toEqual(domains);
  });
});

describe("matchesInternalDomain", () => {
  const domains = ["localhost", "example.com"];

  it("matches exact host and subdomains", () => {
    expect(matchesInternalDomain("http://localhost:3000/x", domains)).toBe(true);
    expect(matchesInternalDomain("https://example.com", domains)).toBe(true);
    expect(matchesInternalDomain("https://app.example.com/path", domains)).toBe(true);
  });

  it("does not match unrelated or look-alike hosts", () => {
    expect(matchesInternalDomain("https://google.com", domains)).toBe(false);
    expect(matchesInternalDomain("https://notexample.com", domains)).toBe(false);
    expect(matchesInternalDomain("https://example.com.evil.com", domains)).toBe(false);
  });

  it("returns false for an unparseable URL or empty domain entries", () => {
    expect(matchesInternalDomain("not a url", domains)).toBe(false);
    expect(matchesInternalDomain("https://example.com", ["", "  "])).toBe(false);
  });
});

describe("resolveTarget", () => {
  const domains = ["localhost", "example.com"];

  afterEach(() => {
    clearDesktopBridgeOverrideForTests();
  });

  it("routes to the system browser when no feature scope is available", () => {
    setDesktopBridgeOverrideForTests({ isElectron: true });
    expect(resolveTarget("https://example.com", domains, null)).toBe("default");
  });

  it("routes to the system browser outside the desktop shell", () => {
    setDesktopBridgeOverrideForTests({ isElectron: false });
    // Even a matching domain can't open a Cadencr tab in a remote/browser session.
    expect(resolveTarget("https://example.com", domains, 7)).toBe("default");
  });

  it("opens matching domains in Cadencr and everything else in the system browser", () => {
    setDesktopBridgeOverrideForTests({ isElectron: true });
    expect(resolveTarget("http://localhost:3000", domains, 7)).toBe("cadencr");
    expect(resolveTarget("https://app.example.com/x", domains, 7)).toBe("cadencr");
    expect(resolveTarget("https://google.com", domains, 7)).toBe("default");
  });
});

import { describe, expect, it } from "vitest";
import {
  browserAutomationAccess,
  isLocalhostAutomationUrl,
  normalizeBrowserOpenUrl,
  redactBrowserHeaders,
} from "./browser-policy";

describe("browser-policy", () => {
  it.each([
    "http://localhost:5173",
    "https://localhost:3000/path",
    "http://127.0.0.1:3001",
    "http://[::1]:3002",
  ])("allows localhost automation for %s", (url: string) => {
    expect(isLocalhostAutomationUrl(url)).toBe(true);
    expect(browserAutomationAccess(url)).toBe("full");
  });

  it.each([
    "https://example.com",
    "http://example.com",
    "file:///tmp/a.html",
    "javascript:alert(1)",
  ])("does not fully allow non-localhost automation for %s", (url: string) => {
    expect(isLocalhostAutomationUrl(url)).toBe(false);
    expect(browserAutomationAccess(url)).not.toBe("full");
  });

  it("denies javascript URLs for opening", () => {
    expect(() => normalizeBrowserOpenUrl("javascript:alert(1)")).toThrow("blocked");
  });

  it("allows file URLs for opening local files", () => {
    expect(normalizeBrowserOpenUrl("file:///tmp/a.html")).toBe("file:///tmp/a.html");
  });

  it("normalizes absolute filesystem paths to file URLs", () => {
    expect(normalizeBrowserOpenUrl("/tmp/a.html")).toBe("file:///tmp/a.html");
    expect(normalizeBrowserOpenUrl("  /Users/alice/My File.html  ")).toBe(
      "file:///Users/alice/My%20File.html",
    );
    expect(normalizeBrowserOpenUrl("/tmp/a#b?.html")).toBe("file:///tmp/a%23b%3F.html");
  });

  it("normalizes bare localhost-like input to http URLs", () => {
    expect(normalizeBrowserOpenUrl("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeBrowserOpenUrl("127.0.0.1:5005/health")).toBe("http://127.0.0.1:5005/health");
  });

  it("allows the safe blank page used for new internal tabs", () => {
    expect(normalizeBrowserOpenUrl("about:blank")).toBe("about:blank");
  });

  it("redacts sensitive headers case-insensitively", () => {
    expect(
      redactBrowserHeaders({
        Authorization: "Bearer secret",
        cookie: "sid=secret",
        "X-Api-Key": "secret",
        Accept: "application/json",
      }),
    ).toEqual({
      Authorization: "[redacted]",
      cookie: "[redacted]",
      "X-Api-Key": "[redacted]",
      Accept: "application/json",
    });
  });
});

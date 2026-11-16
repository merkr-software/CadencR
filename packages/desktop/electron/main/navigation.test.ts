import { describe, expect, it } from "vitest";
import { approvedExternalUrl, isAllowedNavigationUrl, isLoopbackDevUrl } from "./navigation";

describe("navigation policy", () => {
  it("allows only loopback http urls for the dev renderer", () => {
    expect(isLoopbackDevUrl("http://127.0.0.1:1420/")).toBe(true);
    expect(isLoopbackDevUrl("http://localhost:1420/")).toBe(true);
    expect(isLoopbackDevUrl("https://127.0.0.1:1420/")).toBe(false);
    expect(isLoopbackDevUrl("http://user@127.0.0.1:1420/")).toBe(false);
    expect(isLoopbackDevUrl("http://example.com:1420/")).toBe(false);
  });

  it("allows file navigation only in packaged builds", () => {
    expect(isAllowedNavigationUrl("file:///Applications/Cadencr/index.html", true)).toBe(true);
    expect(isAllowedNavigationUrl("http://127.0.0.1:1420/", true)).toBe(false);
    expect(isAllowedNavigationUrl("http://127.0.0.1:1420/", false)).toBe(true);
    expect(isAllowedNavigationUrl("file:///tmp/index.html", false)).toBe(false);
  });

  it("approves only external https urls without credentials or loopback hosts", () => {
    expect(approvedExternalUrl("https://example.com/path")).toBe("https://example.com/path");
    expect(approvedExternalUrl("http://example.com/path")).toBeNull();
    expect(approvedExternalUrl("https://user@example.com/path")).toBeNull();
    expect(approvedExternalUrl("https://localhost/path")).toBeNull();
    expect(approvedExternalUrl("not-a-url")).toBeNull();
  });

  it.each([
    "https://[::1]/",
    "https://[0:0:0:0:0:0:0:1]/",
    "https://127.42.0.8/",
    "https://localhost./",
    "https://LOCALHOST./",
    "https://dev.localhost/",
    "https://2130706433/",
    "https://0x7f000001/",
    "https://127.1/",
    "https://[::ffff:127.0.0.1]/",
  ])("rejects normalized loopback external URL %s", (url) => {
    expect(approvedExternalUrl(url)).toBeNull();
  });
});

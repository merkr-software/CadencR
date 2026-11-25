import { localizedBrowserError } from "../../src/shared/browser-error-copy";
import { uiI18n } from "../../src/shared/ui-i18n";
import { describe, expect, it } from "vitest";
import {
  formatBlockedNavigationError,
  formatBrowserCrashError,
  formatBrowserLoadError,
  isIgnoredLoadErrorCode,
  isIgnoredLoadUrlRejection,
  isViewportPageError,
} from "./browser-load-errors";

describe("isIgnoredLoadErrorCode", () => {
  it("ignores ERR_ABORTED (-3) and keeps real load failures", () => {
    expect(isIgnoredLoadErrorCode(-3)).toBe(true);
    expect(isIgnoredLoadErrorCode(-102)).toBe(false);
    expect(isIgnoredLoadErrorCode(-105)).toBe(false);
    expect(isIgnoredLoadErrorCode(0)).toBe(false);
  });
});

describe("isIgnoredLoadUrlRejection", () => {
  it("ignores ERR_ABORTED rejections by errno, code, or message", () => {
    expect(isIgnoredLoadUrlRejection({ errno: -3 })).toBe(true);
    expect(isIgnoredLoadUrlRejection({ code: "ERR_ABORTED" })).toBe(true);
    expect(isIgnoredLoadUrlRejection(new Error("Navigation failed: ERR_ABORTED"))).toBe(true);
    expect(
      isIgnoredLoadUrlRejection(
        Object.assign(new Error("ERR_ABORTED (-3) loading 'https://example.com/'"), {
          errno: -3,
          code: "ERR_ABORTED",
        }),
      ),
    ).toBe(true);
  });

  it("ignores Chromium ERR_* (-<num>) loading rejections so did-fail-load is authoritative", () => {
    expect(
      isIgnoredLoadUrlRejection(
        new Error("ERR_CONNECTION_REFUSED (-102) loading 'http://localhost:3000/'"),
      ),
    ).toBe(true);
    expect(
      isIgnoredLoadUrlRejection(
        new Error("ERR_NAME_NOT_RESOLVED (-105) loading 'https://missing.invalid/'"),
      ),
    ).toBe(true);
    expect(
      isIgnoredLoadUrlRejection(
        new Error("ERR_CERT_AUTHORITY_INVALID (-202) loading 'https://localhost:8443/'"),
      ),
    ).toBe(true);
    expect(isIgnoredLoadUrlRejection("ERR_EMPTY_RESPONSE (-324) loading 'http://a.test/'")).toBe(
      true,
    );
  });

  it("does not ignore unrelated errors", () => {
    expect(isIgnoredLoadUrlRejection(new Error("WebContents was destroyed"))).toBe(false);
    expect(isIgnoredLoadUrlRejection(new Error("Browser URL is invalid."))).toBe(false);
    expect(isIgnoredLoadUrlRejection({ errno: -102, code: "ERR_CONNECTION_REFUSED" })).toBe(false);
    expect(isIgnoredLoadUrlRejection(null)).toBe(false);
    expect(isIgnoredLoadUrlRejection(undefined)).toBe(false);
    expect(isIgnoredLoadUrlRejection(42)).toBe(false);
  });
});

describe("formatBrowserLoadError", () => {
  it("formats loopback connection refused errors with dev-server guidance", () => {
    for (const [url, host] of [
      ["http://localhost:5173/dashboard", "localhost:5173"],
      ["http://127.0.0.1:8080/", "127.0.0.1:8080"],
      ["http://[::1]:3000/app", "[::1]:3000"],
    ]) {
      const err = formatBrowserLoadError(-102, "ERR_CONNECTION_REFUSED", url);
      expect(err).toEqual({
        kind: "load",
        failure: { reason: "localRefused", host },
        title: `Can't connect to ${host}`,
        description: "Nothing is listening on this port. Make sure your dev server is running.",
        url,
        code: "ERR_CONNECTION_REFUSED",
        retryable: true,
      });
    }
  });

  it("formats non-loopback connection refused errors", () => {
    const err = formatBrowserLoadError(-102, "ERR_CONNECTION_REFUSED", "https://api.example.com/");
    expect(err).toMatchObject({
      kind: "load",
      title: "This site can't be reached",
      description: "api.example.com refused to connect.",
      url: "https://api.example.com/",
      code: "ERR_CONNECTION_REFUSED",
      retryable: true,
    });
  });

  it("maps common Chromium network error codes to human-friendly messages", () => {
    expect(
      formatBrowserLoadError(-105, "ERR_NAME_NOT_RESOLVED", "https://typo.invalid/page"),
    ).toMatchObject({
      title: "Site not found",
      description: "Check the address for typos (typo.invalid).",
      code: "ERR_NAME_NOT_RESOLVED",
    });

    expect(
      formatBrowserLoadError(-106, "ERR_INTERNET_DISCONNECTED", "https://example.com/"),
    ).toMatchObject({
      title: "No internet connection",
      description: "Check your network connection and try again.",
    });

    expect(
      formatBrowserLoadError(-118, "ERR_CONNECTION_TIMED_OUT", "https://slow.example.com/"),
    ).toMatchObject({
      title: "Connection timed out",
      description: "slow.example.com took too long to respond.",
    });
    expect(formatBrowserLoadError(-7, "ERR_TIMED_OUT", "https://slow.example.com/")).toMatchObject({
      title: "Connection timed out",
      description: "slow.example.com took too long to respond.",
    });

    expect(
      formatBrowserLoadError(-101, "ERR_CONNECTION_RESET", "https://reset.example.com/"),
    ).toMatchObject({
      title: "Connection interrupted",
      description: "The connection to reset.example.com was closed unexpectedly.",
    });
    expect(
      formatBrowserLoadError(-100, "ERR_CONNECTION_CLOSED", "https://closed.example.com/"),
    ).toMatchObject({
      title: "Connection interrupted",
      description: "The connection to closed.example.com was closed unexpectedly.",
    });

    expect(
      formatBrowserLoadError(-324, "ERR_EMPTY_RESPONSE", "https://empty.example.com/"),
    ).toMatchObject({
      title: "No response from server",
      description: "empty.example.com didn't send any data.",
    });

    expect(
      formatBrowserLoadError(-310, "ERR_TOO_MANY_REDIRECTS", "https://loop.example.com/"),
    ).toMatchObject({
      title: "Too many redirects",
      description: "loop.example.com redirected you too many times.",
    });

    expect(
      formatBrowserLoadError(-109, "ERR_ADDRESS_UNREACHABLE", "http://10.255.255.1/"),
    ).toMatchObject({
      title: "Address unreachable",
      description: "Could not reach 10.255.255.1.",
    });

    expect(
      formatBrowserLoadError(-6, "ERR_FILE_NOT_FOUND", "file:///tmp/missing.html"),
    ).toMatchObject({
      title: "File not found",
      description: "The requested file could not be found.",
    });

    expect(
      formatBrowserLoadError(-312, "ERR_UNSAFE_PORT", "http://example.com:6667/"),
    ).toMatchObject({
      kind: "security",
      title: "Port blocked",
      description: "This port is blocked for security reasons.",
    });
  });

  it("formats TLS/SSL errors by code range and description prefix, distinguishing loopback", () => {
    expect(
      formatBrowserLoadError(-202, "ERR_CERT_AUTHORITY_INVALID", "https://localhost:8443/"),
    ).toMatchObject({
      kind: "security",
      title: "Connection isn't private",
      description: "The local HTTPS certificate for localhost:8443 isn't trusted.",
    });

    expect(
      formatBrowserLoadError(-200, "ERR_CERT_COMMON_NAME_INVALID", "https://badssl.example.com/"),
    ).toMatchObject({
      kind: "security",
      title: "Connection isn't private",
      description: "The security certificate for badssl.example.com isn't trusted.",
    });

    expect(
      formatBrowserLoadError(-217, "ERR_CERT_KNOWN_INTERCEPTION_BLOCKED", "https://corp.test/"),
    ).toMatchObject({
      kind: "security",
      title: "Connection isn't private",
      description: "The security certificate for corp.test isn't trusted.",
    });

    expect(
      formatBrowserLoadError(
        -113,
        "ERR_SSL_VERSION_OR_CIPHER_MISMATCH",
        "https://old.example.com/",
      ),
    ).toMatchObject({
      kind: "security",
      title: "Connection isn't private",
      description: "The security certificate for old.example.com isn't trusted.",
    });
  });

  it("falls back cleanly for unknown error codes, unparseable URLs, and empty descriptions", () => {
    const err = formatBrowserLoadError(-999, "", "https://unknown.example.com/path");
    expect(err).toMatchObject({
      kind: "load",
      title: "This page can't be loaded",
      description: "Could not load unknown.example.com.",
      url: "https://unknown.example.com/path",
      code: undefined,
      retryable: true,
    });

    const badUrl = formatBrowserLoadError(-999, "ERR_FAILED", "not-a-valid-url");
    expect(badUrl.description).toBe("Could not load not-a-valid-url.");
  });
});

describe("formatBrowserCrashError", () => {
  it("formats out-of-memory crashes specifically", () => {
    const err = formatBrowserCrashError("oom", "https://heavy.example.com/");
    expect(err).toEqual({
      kind: "crash",
      failure: { reason: "outOfMemory" },
      title: "This page ran out of memory",
      description: "Reload the tab to try again.",
      url: "https://heavy.example.com/",
      code: "oom",
      retryable: true,
    });
  });

  it("formats generic renderer crashes", () => {
    const err = formatBrowserCrashError("crashed", "https://example.com/");
    expect(err).toEqual({
      kind: "crash",
      failure: { reason: "crash" },
      title: "This page crashed",
      description: "Something went wrong while displaying this page. Reload to try again.",
      url: "https://example.com/",
      code: "crashed",
      retryable: true,
    });
  });
});

describe("formatBlockedNavigationError", () => {
  it("creates a non-retryable blocked navigation error", () => {
    const err = formatBlockedNavigationError(
      "Navigation blocked",
      "Shared browser tabs cannot redirect to Cadencr's own interface.",
      "http://localhost:1420/",
    );
    expect(err).toEqual({
      kind: "blocked",
      title: "Navigation blocked",
      description: "Shared browser tabs cannot redirect to Cadencr's own interface.",
      url: "http://localhost:1420/",
      retryable: false,
    });

    const withoutUrl = formatBlockedNavigationError("Blocked", "Not allowed.");
    expect(withoutUrl.url).toBeUndefined();
  });
});

describe("isViewportPageError", () => {
  it("returns true only for load, security, and crash errors", () => {
    expect(
      isViewportPageError(
        formatBrowserLoadError(-102, "ERR_CONNECTION_REFUSED", "http://localhost:3000/"),
      ),
    ).toBe(true);
    expect(
      isViewportPageError(
        formatBrowserLoadError(-202, "ERR_CERT_AUTHORITY_INVALID", "https://localhost:8443/"),
      ),
    ).toBe(true);
    expect(isViewportPageError(formatBrowserCrashError("crashed", "https://example.com/"))).toBe(
      true,
    );
    expect(isViewportPageError(formatBlockedNavigationError("Blocked", "No."))).toBe(false);
    expect(isViewportPageError({ kind: "internal", title: "Error", description: "Oops" })).toBe(
      false,
    );
    expect(isViewportPageError(null)).toBe(false);
    expect(isViewportPageError(undefined)).toBe(false);
  });
});

it("relabels an existing navigation failure without loading a new page or altering diagnostic data", () => {
  const url = "https://missing.invalid/keep-this-path";
  const error = formatBrowserLoadError(-105, "ERR_NAME_NOT_RESOLVED", url);
  expect(localizedBrowserError(error, uiI18n.getFixedT("cimode", "ui"))).toEqual({
    title: "workspace.browser.error.notFound.title",
    description: "workspace.browser.error.notFound.description",
  });
  expect(error).toMatchObject({ url, code: "ERR_NAME_NOT_RESOLVED", title: "Site not found" });
});

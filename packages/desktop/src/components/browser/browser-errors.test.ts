import { describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { formatBrowserIpcError, showBrowserError } from "./browser-errors";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
  },
}));

describe("formatBrowserIpcError", () => {
  it("strips Electron IPC remote method wrapper with Error: prefix", () => {
    const err = new Error(
      "Error invoking remote method 'browser:navigate-tab': Error: Invalid URL protocol",
    );
    expect(formatBrowserIpcError(err)).toBe("Invalid URL protocol");
  });

  it("strips Electron IPC remote method wrapper without inner Error: prefix", () => {
    const err = new Error("Error invoking remote method 'browser:create-tab': Tab limit reached");
    expect(formatBrowserIpcError(err)).toBe("Tab limit reached");
  });

  it("strips a leading Error: prefix from plain strings and Error messages", () => {
    expect(formatBrowserIpcError("Error: Permission denied")).toBe("Permission denied");
    expect(formatBrowserIpcError(new Error("Error: Connection refused"))).toBe(
      "Connection refused",
    );
  });

  it("preserves clean messages untouched", () => {
    expect(formatBrowserIpcError(new Error("Could not load page"))).toBe("Could not load page");
    expect(formatBrowserIpcError("Something went wrong")).toBe("Something went wrong");
  });

  it("falls back when an error message is blank after stripping", () => {
    expect(formatBrowserIpcError("")).toBe("Unknown error");
  });
});

describe("showBrowserError", () => {
  it("passes the cleaned IPC error message to toast.error", () => {
    showBrowserError(
      new Error("Error invoking remote method 'browser:reload': Error: Tab closed"),
      "Browser action failed",
    );
    expect(toast.error).toHaveBeenCalledWith("Browser action failed", {
      description: "Tab closed",
    });
  });
});

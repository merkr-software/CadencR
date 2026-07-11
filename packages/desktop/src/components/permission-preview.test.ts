import { describe, expect, it } from "vitest";
import { getPermissionPreview } from "./permission-preview";

describe("getPermissionPreview", () => {
  it("returns the explicit preview when provided", () => {
    expect(getPermissionPreview({ preview: "ls -la", input: {} })).toBe("ls -la");
  });

  it("extracts the command from the input object", () => {
    expect(getPermissionPreview({ input: { command: "git status" } })).toBe("git status");
  });

  it("returns null when the input is missing (does not crash)", () => {
    // Regression: opening the unified agent view crashed with
    // "Cannot read properties of undefined (reading 'command')" when a
    // pending permission arrived without an `input` field.
    expect(getPermissionPreview({} as { input?: Record<string, unknown> })).toBeNull();
  });

  it("returns null when the input is null (does not crash)", () => {
    expect(getPermissionPreview({ input: null })).toBeNull();
  });

  it("can omit the raw JSON fallback for compact summaries", () => {
    expect(getPermissionPreview({ input: { opaque: "value" }, fallbackToJson: false })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { CadencrError } from "./errors.js";
import { HOST_REPORTED_BACKEND_CODES, isReportedByHost } from "./host-reported.js";

describe("isReportedByHost", () => {
  it("is true only for the backend failures Cadencr shows itself", () => {
    for (const code of HOST_REPORTED_BACKEND_CODES)
      expect(isReportedByHost(new CadencrError(code, "x"))).toBe(true);
    for (const code of ["TIMEOUT", "PLUGIN_BACKEND_BUSY", "PLUGIN_BACKEND_EXITED", "NOT_FOUND"])
      expect(isReportedByHost(new CadencrError(code, "x"))).toBe(false);
  });

  it("is false for anything that is not a CadencrError", () => {
    expect(isReportedByHost(new Error("PLUGIN_BACKEND_UNSIGNED"))).toBe(false);
    expect(isReportedByHost({ code: "PLUGIN_BACKEND_UNSIGNED" })).toBe(false);
    expect(isReportedByHost(undefined)).toBe(false);
  });
});

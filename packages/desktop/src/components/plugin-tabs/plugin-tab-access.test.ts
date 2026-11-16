import { describe, expect, it } from "vitest";

import { linuxOnlyBackendTab, pluginTabSummary } from "./plugin-tab-fixtures";
import {
  backendUnavailableHere,
  reasonClause,
  reasonSentence,
  unavailableReason,
} from "./plugin-tab-access";

describe("plugin tab access copy", () => {
  it("ends a service reason once, whatever punctuation it came with", () => {
    expect(reasonClause("Malware.")).toBe("Malware");
    expect(reasonClause("  Leaks tokens!? ")).toBe("Leaks tokens");
    expect(reasonClause("Still loading…")).toBe("Still loading");
    expect(reasonClause("No stop")).toBe("No stop");
    expect(`Not installed: ${reasonClause("Revoked.")}.`).toBe("Not installed: Revoked.");
    expect(reasonSentence("Revoked")).toBe("Revoked.");
    expect(reasonSentence("Revoked?")).toBe("Revoked?");
  });

  it("names where a backend that can't run here does ship", () => {
    expect(unavailableReason("Linux (x86-64)")).toBe(
      "Its native backend ships for Linux (x86-64) only, so the tab can't run on this computer.",
    );
  });

  it("treats only a declared backend with no binary for this platform as unavailable", () => {
    expect(backendUnavailableHere(linuxOnlyBackendTab())).toBe(true);
    expect(backendUnavailableHere(linuxOnlyBackendTab({ backend_availability: "available" }))).toBe(
      false,
    );
    expect(
      backendUnavailableHere(pluginTabSummary({ backend_availability: "unavailable_on_platform" })),
    ).toBe(false);
  });
});

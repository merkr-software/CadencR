import { describe, expect, it } from "vitest";

import { linuxOnlyBackendTab, OFF_ENABLEMENT, pluginTabSummary } from "./plugin-tab-fixtures";
import { resolveTabReplacements } from "./tab-replacement";

describe("resolveTabReplacements", () => {
  const vcs = pluginTabSummary({ id: "vcs", label: "VCS", replaces: ["git", "editor"] });

  it("shows a chosen tab that declares the built-in and can run", () => {
    const resolved = resolveTabReplacements({ git: "vcs" }, [vcs], true);
    expect([...resolved]).toEqual([["git", vcs]]);
  });

  it("keeps the built-in when the choice cannot show there", () => {
    const cases = [
      // Not listed for this project, or gone.
      [],
      // No longer declares Git.
      [{ ...vcs, replaces: ["editor"] }],
      // Off in this project.
      [{ ...vcs, enablement: OFF_ENABLEMENT }],
      // Not built yet.
      [{ ...vcs, entry_present: false }],
      // Errors in its manifest.
      [{ ...vcs, status: "invalid" as const }],
      // Its backend has no build for this platform.
      [linuxOnlyBackendTab({ id: "vcs", replaces: ["git"] })],
    ];
    for (const summaries of cases) {
      expect(resolveTabReplacements({ git: "vcs" }, summaries, true).size).toBe(0);
    }
    expect(resolveTabReplacements({ git: "vcs" }, [vcs], false).size).toBe(0);
    expect(resolveTabReplacements({ git: "vcs" }, undefined, true).size).toBe(0);
  });
});

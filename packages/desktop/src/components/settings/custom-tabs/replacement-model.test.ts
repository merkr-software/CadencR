import { describe, expect, it } from "vitest";

import { OFF_ENABLEMENT, pluginTabSummary } from "@/components/plugin-tabs/plugin-tab-fixtures";

import type { ProjectOverride } from "./custom-tab-model";
import { candidateLabel, describeReplacement, replacementSlots } from "./replacement-model";

const NO_OVERRIDES = () => new Map<number, ProjectOverride>();

const vcs = pluginTabSummary({ id: "vcs", label: "VCS", replaces: ["git"] });
const forge = pluginTabSummary({ id: "forge", label: "Forge", replaces: ["git", "editor"] });

describe("replacementSlots", () => {
  it("lists the built-ins some tab can replace or a choice names, in strip order", () => {
    const slots = replacementSlots([vcs, forge], { preview: "gone" });
    expect(
      slots.map((slot) => [slot.tab, slot.candidates.map((tab) => tab.id), slot.chosenId]),
    ).toEqual([
      ["git", ["vcs", "forge"], null],
      ["editor", ["forge"], null],
      ["preview", [], "gone"],
    ]);
    expect(replacementSlots([pluginTabSummary()], {})).toEqual([]);
  });
});

describe("describeReplacement", () => {
  const [git] = replacementSlots([vcs, forge], {});

  it("invites a choice between several candidates", () => {
    expect(describeReplacement(git!, [vcs, forge], NO_OVERRIDES).text).toBe(
      "2 custom tabs can replace Git; it shows the built-in until you pick one.",
    );
  });

  it("says where the chosen tab shows", () => {
    const chosen = { ...git!, chosenId: "vcs" };
    expect(describeReplacement(chosen, [vcs], NO_OVERRIDES)).toEqual({
      text: "VCS shows in place of Git in every project where it is on.",
      tone: "muted",
    });
    const offGlobally = { ...vcs, enablement: OFF_ENABLEMENT };
    expect(
      describeReplacement(
        chosen,
        [offGlobally],
        () => new Map<number, ProjectOverride>([[3, true]]),
      ).text,
    ).toBe("VCS shows in place of Git in the project where it is on.");
    expect(describeReplacement(chosen, [offGlobally], NO_OVERRIDES)).toEqual({
      text: "VCS is off in every project, so Git shows. Turn it on below.",
      tone: "warning",
    });
  });

  it("warns when the choice cannot show anywhere", () => {
    const chosen = (chosenId: string) => ({ ...git!, chosenId });
    expect(describeReplacement(chosen("gone"), [vcs], NO_OVERRIDES)).toEqual({
      text: "The custom tab “gone” is no longer installed, so Git shows.",
      tone: "warning",
    });
    expect(describeReplacement(chosen("vcs"), [{ ...vcs, replaces: [] }], NO_OVERRIDES).text).toBe(
      "VCS no longer says it can replace Git, so Git shows.",
    );
    expect(
      describeReplacement(chosen("vcs"), [{ ...vcs, entry_present: false }], NO_OVERRIDES).text,
    ).toBe("VCS isn't built yet, so Git shows.");
    // Why it can't run comes before where it is on.
    expect(
      describeReplacement(
        chosen("vcs"),
        [{ ...vcs, entry_present: false, enablement: OFF_ENABLEMENT }],
        NO_OVERRIDES,
      ).text,
    ).toBe("VCS isn't built yet, so Git shows.");
  });

  it("warns while new permissions wait for approval", () => {
    const pending = {
      ...vcs,
      enablement: { global: true, project: null, effective: false, consent_required: true },
    };
    expect(describeReplacement({ ...git!, chosenId: "vcs" }, [pending], NO_OVERRIDES)).toEqual({
      text: "VCS waits for you to approve its new permissions, so Git shows.",
      tone: "warning",
    });
  });
});

describe("candidateLabel", () => {
  it("says a tab moves from the built-in it replaces now", () => {
    expect(candidateLabel(forge, "git", { editor: "forge" })).toBe("Forge (moves from Editor)");
    expect(candidateLabel(forge, "git", { git: "forge" })).toBe("Forge");
  });
});

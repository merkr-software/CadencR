import type { PluginTabSummary } from "@/api/generated";
import {
  BUILTIN_TAB_LABELS,
  REPLACEABLE_TABS,
  replacedBy,
  type ReplaceableTab,
  type TabReplacementChoices,
} from "@/lib/plugin-tabs/tab-replacements";

import {
  customTabStatus,
  isSwitchedOnAnywhere,
  type CustomTabStatus,
  type ProjectOverride,
} from "./custom-tab-model";

/** One built-in tab in Settings → Custom tabs → Replace built-in tabs. */
export interface ReplacementSlot {
  tab: ReplaceableTab;
  /** Valid or not, every tab whose manifest lists this built-in in `tab.replaces`. */
  candidates: PluginTabSummary[];
  /** The stored choice, even when it no longer resolves to a candidate. */
  chosenId: string | null;
}

/**
 * The built-ins worth a row: some tab declares it can replace them, or a
 * choice is stored for them (it may need undoing). Strip order.
 */
export function replacementSlots(
  tabs: readonly PluginTabSummary[],
  choices: TabReplacementChoices,
): ReplacementSlot[] {
  return REPLACEABLE_TABS.flatMap((tab) => {
    const candidates = tabs.filter((summary) => summary.replaces.includes(tab));
    const chosenId = choices[tab] ?? null;
    return candidates.length > 0 || chosenId ? [{ tab, candidates, chosenId }] : [];
  });
}

export type ReplacementTone = "muted" | "warning";

/**
 * What a row's choice does, in words: where the custom tab shows instead of
 * the built-in, or why the built-in still shows. Settings lists tabs without
 * a project, so "where it's on" is read from the global switch and the
 * project overrides.
 */
export function describeReplacement(
  slot: ReplacementSlot,
  tabs: readonly PluginTabSummary[],
  overrides: (tabId: string) => ReadonlyMap<number, ProjectOverride>,
): { text: string; tone: ReplacementTone } {
  const builtin = BUILTIN_TAB_LABELS[slot.tab];
  if (!slot.chosenId) {
    const count = slot.candidates.length;
    return {
      text:
        count > 1
          ? `${count} custom tabs can replace ${builtin}; it shows the built-in until you pick one.`
          : `${slot.candidates[0]?.label ?? "A custom tab"} can replace ${builtin}.`,
      tone: "muted",
    };
  }
  const summary = tabs.find((candidate) => candidate.id === slot.chosenId);
  const warn = (text: string) => ({
    text: `${text}, so ${builtin} shows.`,
    tone: "warning" as const,
  });
  if (!summary) return warn(`The custom tab “${slot.chosenId}” is no longer installed`);
  if (!summary.replaces.includes(slot.tab)) {
    return warn(`${summary.label} no longer says it can replace ${builtin}`);
  }
  const status = customTabStatus(summary);
  if (status !== "valid") return warn(`${summary.label} ${NOT_RUNNING[status]}`);
  const overridden = overrides(summary.id);
  if (!isSwitchedOnAnywhere(summary, overridden)) {
    return {
      text: `${summary.label} is off in every project, so ${builtin} shows. Turn it on below.`,
      tone: "warning",
    };
  }
  if (summary.enablement.consent_required) {
    return warn(`${summary.label} waits for you to approve its new permissions`);
  }
  return { text: whereItShows(summary, builtin, overridden), tone: "muted" };
}

const NOT_RUNNING: Record<Exclude<CustomTabStatus, "valid">, string> = {
  blocked: "is blocked",
  invalid: "has errors",
  unavailable: "can't run on this platform",
  "not-built": "isn't built yet",
};

function whereItShows(
  summary: PluginTabSummary,
  builtin: string,
  overrides: ReadonlyMap<number, ProjectOverride>,
): string {
  if (summary.enablement.global === true) {
    return `${summary.label} shows in place of ${builtin} in every project where it is on.`;
  }
  const projectsOn = [...overrides.values()].filter((enabled) => enabled === true).length;
  const where = projectsOn === 1 ? "project" : `${projectsOn} projects`;
  return `${summary.label} shows in place of ${builtin} in the ${where} where it is on.`;
}

/** Where a candidate already stands in for another built-in, for its option label. */
export function candidateLabel(
  summary: PluginTabSummary,
  tab: ReplaceableTab,
  choices: TabReplacementChoices,
): string {
  const elsewhere = replacedBy(choices, summary.id);
  return elsewhere && elsewhere !== tab
    ? `${summary.label} (moves from ${BUILTIN_TAB_LABELS[elsewhere]})`
    : summary.label;
}

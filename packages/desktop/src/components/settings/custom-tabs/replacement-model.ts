import { translateUi, type UiTranslator } from "@/lib/i18n/ui";
import type { PluginTabSummary } from "@/api/generated";
import {
  builtinTabLabel,
  REPLACEABLE_TABS,
  replacedBy,
  type ReplaceableTab,
  type TabReplacementChoices,
} from "@/lib/plugin-tabs/tab-replacements";

import { customTabStatus, isSwitchedOnAnywhere, type ProjectOverride } from "./custom-tab-model";

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
  t: UiTranslator = translateUi,
): { text: string; tone: ReplacementTone } {
  const builtin = builtinTabLabel(slot.tab, t);
  if (!slot.chosenId) {
    const count = slot.candidates.length;
    return {
      text:
        count > 1
          ? t(
              "customTabs.replacements.multipleCandidates",
              "{{count}} custom tabs can replace {{builtin}}; it shows the built-in until you pick one.",
              { count, builtin },
            )
          : slot.candidates[0]
            ? t("customTabs.replacements.oneCandidate", "{{label}} can replace {{builtin}}.", {
                label: slot.candidates[0].label,
                builtin,
              })
            : t(
                "customTabs.replacements.genericCandidate",
                "A custom tab can replace {{builtin}}.",
                { builtin },
              ),
      tone: "muted",
    };
  }
  const summary = tabs.find((candidate) => candidate.id === slot.chosenId);
  if (!summary)
    return warn(
      t(
        "customTabs.replacements.missing",
        "The custom tab “{{id}}” is no longer installed, so {{builtin}} shows.",
        { id: slot.chosenId, builtin },
      ),
    );
  if (!summary.replaces.includes(slot.tab)) {
    return warn(
      t(
        "customTabs.replacements.noLongerOffered",
        "{{label}} no longer says it can replace {{builtin}}, so {{builtin}} shows.",
        { label: summary.label, builtin },
      ),
    );
  }
  const values = { label: summary.label, builtin };
  switch (customTabStatus(summary)) {
    case "blocked":
      return warn(
        t("customTabs.replacements.blocked", "{{label}} is blocked, so {{builtin}} shows.", values),
      );
    case "invalid":
      return warn(
        t("customTabs.replacements.invalid", "{{label}} has errors, so {{builtin}} shows.", values),
      );
    case "unavailable":
      return warn(
        t(
          "customTabs.replacements.unavailable",
          "{{label}} can't run on this platform, so {{builtin}} shows.",
          values,
        ),
      );
    case "not-built":
      return warn(
        t(
          "customTabs.replacements.notBuilt",
          "{{label}} isn't built yet, so {{builtin}} shows.",
          values,
        ),
      );
  }
  const overridden = overrides(summary.id);
  if (!isSwitchedOnAnywhere(summary, overridden)) {
    return {
      text: t(
        "customTabs.replacements.switchedOff",
        "{{label}} is off in every project, so {{builtin}} shows. Turn it on below.",
        { ...values },
      ),
      tone: "warning",
    };
  }
  if (summary.enablement.consent_required) {
    return warn(
      t(
        "customTabs.replacements.waitingApproval",
        "{{label}} waits for you to approve its new permissions, so {{builtin}} shows.",
        { ...values },
      ),
    );
  }
  return { text: whereItShows(summary, builtin, overridden, t), tone: "muted" };
}

function warn(text: string): { text: string; tone: ReplacementTone } {
  return { text, tone: "warning" };
}

function whereItShows(
  summary: PluginTabSummary,
  builtin: string,
  overrides: ReadonlyMap<number, ProjectOverride>,
  t: UiTranslator,
): string {
  if (summary.enablement.global === true) {
    return t(
      "customTabs.replacements.allProjects",
      "{{label}} shows in place of {{builtin}} in every project where it is on.",
      { label: summary.label, builtin },
    );
  }
  const projectsOn = [...overrides.values()].filter((enabled) => enabled === true).length;
  return t("customTabs.replacements.projectsOn", {
    count: projectsOn,
    label: summary.label,
    builtin,
    defaultValue_zero:
      "{{label}} shows in place of {{builtin}} in the {{count}} projects where it is on.",
    defaultValue_one: "{{label}} shows in place of {{builtin}} in the project where it is on.",
    defaultValue_other:
      "{{label}} shows in place of {{builtin}} in the {{count}} projects where it is on.",
  });
}

/** Where a candidate already stands in for another built-in, for its option label. */
export function candidateLabel(
  summary: PluginTabSummary,
  tab: ReplaceableTab,
  choices: TabReplacementChoices,
  t: UiTranslator = translateUi,
): string {
  const elsewhere = replacedBy(choices, summary.id);
  return elsewhere && elsewhere !== tab
    ? t("customTabs.replacements.candidateMoves", "{{label}} (moves from {{builtin}})", {
        label: summary.label,
        builtin: builtinTabLabel(elsewhere, t),
      })
    : summary.label;
}

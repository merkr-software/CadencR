import type { PluginTabSummary } from "@/api/generated";
import { backendUnavailableHere } from "@/components/plugin-tabs/plugin-tab-access";

/**
 * Pure helpers behind the Custom tabs settings section: what a tab's status,
 * permissions and switches mean in words. Kept free of React so the wording is
 * tested once and shared by the card, the consent dialog and the summaries.
 */

/** The settings section id — the `?section=` deep link other code points at. */
export const CUSTOM_TABS_SECTION_ID = "custom-tabs";

/** What each scope of `docs/CUSTOM_TABS.md` §6 lets a tab do, in the user's terms. */
const SCOPE_DESCRIPTIONS: Record<string, { title: string; description: string }> = {
  "features:read": {
    title: "This conversation",
    description: "See the conversation and its project, plus the project's other conversations.",
  },
  "git:read": {
    title: "Git",
    description: "Read the status, diffs, history and branches of this conversation's worktree.",
  },
  "forge:read": {
    title: "Pull requests",
    description: "Read the pull request status and checks of this conversation.",
  },
  "files:read": {
    title: "Files",
    description: "Read files in this conversation's worktree and see when they change.",
  },
  "agent:observe": {
    title: "Agent activity",
    description: "Read this conversation's agent history and follow it live.",
  },
  "workspace:read": {
    title: "Whole workspace",
    description: "See every project and conversation in Cadencr, and what each agent is doing.",
  },
};

export function describeScope(scope: string): { title: string; description: string } {
  return (
    SCOPE_DESCRIPTIONS[scope] ?? {
      title: scope,
      description: "A permission this version of Cadencr does not know.",
    }
  );
}

export type CustomTabStatus = "blocked" | "valid" | "invalid" | "unavailable" | "not-built";

/**
 * A revoked (blocked) tab outranks everything: nothing on this computer makes
 * it run again. Then a broken manifest: fixing `tab.json` comes first. A
 * backend with no build for this platform outranks a missing page build,
 * which would not make the tab run here.
 */
export function customTabStatus(tab: PluginTabSummary): CustomTabStatus {
  if (tab.status === "blocked") return "blocked";
  if (tab.status === "invalid") return "invalid";
  if (backendUnavailableHere(tab)) return "unavailable";
  return tab.entry_present ? "valid" : "not-built";
}

/**
 * Whether a switch may turn the tab on. An invalid or blocked tab can be
 * switched off, never (back) on: the service would refuse it.
 */
export function canTurnOn(tab: Pick<PluginTabSummary, "status">): boolean {
  return tab.status === "valid";
}

/** A project override: `true`/`false` when set, `null` when it follows the global switch. */
export type ProjectOverride = boolean | null;
export type TriState = "inherit" | "on" | "off";

export function triStateOf(override: ProjectOverride | undefined): TriState {
  if (override === true) return "on";
  if (override === false) return "off";
  return "inherit";
}

export function overrideOf(state: TriState): ProjectOverride {
  if (state === "on") return true;
  if (state === "off") return false;
  return null;
}

/**
 * Where the tab is switched on, ignoring consent and validity: "On everywhere",
 * "On in N projects" or "Off". `overrides` maps project id → override for the
 * projects that have one.
 */
export function enablementSummary(
  tab: PluginTabSummary,
  overrides: ReadonlyMap<number, ProjectOverride>,
  projectIds: readonly number[],
): string {
  const global = tab.enablement.global === true;
  const switchedOn = projectIds.filter((id) => overrides.get(id) ?? global).length;
  if (global && switchedOn === projectIds.length) return "On everywhere";
  if (switchedOn === 0) return global ? "On for new projects" : "Off";
  return switchedOn === 1 ? "On in 1 project" : `On in ${switchedOn} projects`;
}

/** Switched on somewhere — the state in which a missing consent actually stops the tab. */
export function isSwitchedOnAnywhere(
  tab: PluginTabSummary,
  overrides: ReadonlyMap<number, ProjectOverride>,
): boolean {
  return tab.enablement.global === true || [...overrides.values()].some((value) => value === true);
}

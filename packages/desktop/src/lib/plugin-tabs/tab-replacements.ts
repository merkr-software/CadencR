import { z } from "zod";

import { parseJsonSetting, type ParsedJsonSetting } from "@/lib/json-setting";
import { PLUGIN_TAB_ID_PATTERN } from "@/shared/plugin-tab-host";
import type { BuiltinTabKind } from "@/stores/feature-layout-schema";

/**
 * Workspace setting naming the custom tab shown in place of each built-in tab,
 * e.g. `{"git":"my-vcs"}` (docs/CUSTOM_TABS.md §10). Mirrors
 * `custom_tab_replacements` in the service's settings allowlist.
 */
export const TAB_REPLACEMENTS_KEY = "custom_tab_replacements";

/**
 * Built-in tabs a custom tab may replace, in tab-strip order. Mirrors
 * `REPLACEABLE_TABS` in `cadencr-plugin-core`; Agent and Browser stay.
 */
export const REPLACEABLE_TABS = [
  "terminal",
  "git",
  "editor",
  "preview",
] as const satisfies readonly BuiltinTabKind[];

export type ReplaceableTab = (typeof REPLACEABLE_TABS)[number];

/** The built-ins' tab-strip labels. */
export const BUILTIN_TAB_LABELS: Readonly<Record<ReplaceableTab, string>> = {
  terminal: "Terminal",
  git: "Git",
  editor: "Editor",
  preview: "Preview",
};

/** Built-in tab → id of the custom tab chosen to replace it. */
export type TabReplacementChoices = Readonly<Partial<Record<ReplaceableTab, string>>>;

export const NO_TAB_REPLACEMENTS: TabReplacementChoices = Object.freeze({});

export function isReplaceableTab(tab: unknown): tab is ReplaceableTab {
  return REPLACEABLE_TABS.includes(tab as ReplaceableTab);
}

const choicesSchema = z
  .partialRecord(z.enum(REPLACEABLE_TABS), z.string().regex(PLUGIN_TAB_ID_PATTERN))
  .refine((choices) => new Set(Object.values(choices)).size === Object.keys(choices).length);

/**
 * The stored choices, or none when unset or malformed (the service drops a
 * malformed value on read too): every built-in tab then shows. `error` says
 * why a stored value was dropped.
 */
export function readTabReplacements(
  value: string | null | undefined,
): ParsedJsonSetting<TabReplacementChoices> {
  return parseJsonSetting(
    value,
    choicesSchema,
    "expected each built-in tab mapped to a different custom tab id",
  );
}

export function parseTabReplacements(value: string | null | undefined): TabReplacementChoices {
  return readTabReplacements(value).value ?? NO_TAB_REPLACEMENTS;
}

export function hasTabReplacements(choices: TabReplacementChoices): boolean {
  return Object.keys(choices).length > 0;
}

/** Keys in strip order, so equal choices always serialize alike. */
export function serializeTabReplacements(choices: TabReplacementChoices): string {
  const ordered: Partial<Record<ReplaceableTab, string>> = {};
  for (const tab of REPLACEABLE_TABS) {
    const id = choices[tab];
    if (id) ordered[tab] = id;
  }
  return JSON.stringify(ordered);
}

/**
 * `choices` with `tab` replaced by `tabId`, or back to its built-in for
 * `null`. A custom tab replaces one built-in at a time: choosing it here
 * frees the built-in it replaced before.
 */
export function withTabReplacement(
  choices: TabReplacementChoices,
  tab: ReplaceableTab,
  tabId: string | null,
): TabReplacementChoices {
  const next: Partial<Record<ReplaceableTab, string>> = {};
  for (const slot of REPLACEABLE_TABS) {
    const id = choices[slot];
    if (id && slot !== tab && id !== tabId) next[slot] = id;
  }
  if (tabId) next[tab] = tabId;
  return next;
}

/** The built-in tab `tabId` replaces in `choices`, if any. */
export function replacedBy(choices: TabReplacementChoices, tabId: string): ReplaceableTab | null {
  return REPLACEABLE_TABS.find((tab) => choices[tab] === tabId) ?? null;
}

/** The replaceable built-ins a summary's `replaces` declares, in strip order. */
export function declaredReplacements(replaces: readonly string[]): ReplaceableTab[] {
  return REPLACEABLE_TABS.filter((tab) => replaces.includes(tab));
}

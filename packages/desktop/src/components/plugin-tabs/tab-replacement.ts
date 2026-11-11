import { useMemo } from "react";

import {
  useGetWorkspaceSetting,
  type PluginTabSummary,
  type SettingValueResponse,
} from "@/api/generated";
import { pluginTabsAvailable } from "@/lib/plugin-tabs/availability";
import { isSetAside, useBuiltinFallbacks } from "@/lib/plugin-tabs/builtin-fallback";
import {
  parseTabReplacements,
  REPLACEABLE_TABS,
  TAB_REPLACEMENTS_KEY,
  type ReplaceableTab,
  type TabReplacementChoices,
} from "@/lib/plugin-tabs/tab-replacements";

import { staticOverlayState } from "./PluginTabView";

/** Built-in tab → the custom tab shown in its place. */
export type ResolvedReplacements = ReadonlyMap<ReplaceableTab, PluginTabSummary>;

/**
 * The custom tabs chosen in one project (`summaries` is that project's list)
 * that still declare their built-in in `tab.replaces`, running or not.
 */
export function chosenReplacements(
  choices: TabReplacementChoices,
  summaries: readonly PluginTabSummary[] | undefined,
): ResolvedReplacements {
  const chosen = new Map<ReplaceableTab, PluginTabSummary>();
  if (!summaries) return chosen;
  for (const tab of REPLACEABLE_TABS) {
    const id = choices[tab];
    const summary = id ? summaries.find((candidate) => candidate.id === id) : undefined;
    if (summary?.replaces.includes(tab)) chosen.set(tab, summary);
  }
  return chosen;
}

/**
 * The custom tabs shown in place of built-ins in one project: chosen, and
 * able to run there. Otherwise the built-in keeps its place rather than an
 * error where Git used to be.
 */
export function resolveTabReplacements(
  choices: TabReplacementChoices,
  summaries: readonly PluginTabSummary[] | undefined,
  desktop: boolean,
): ResolvedReplacements {
  return new Map(
    [...chosenReplacements(choices, summaries)].filter(
      ([, summary]) => staticOverlayState(summary, desktop) === null,
    ),
  );
}

const selectChoices = (setting: SettingValueResponse): TabReplacementChoices =>
  parseTabReplacements(setting.value);

/**
 * The stored choices, or `undefined` until they are read (or while disabled).
 * Kept current by the settings event, never refetched on its own.
 */
export function useTabReplacementChoices(enabled = true): TabReplacementChoices | undefined {
  const { data } = useGetWorkspaceSetting(TAB_REPLACEMENTS_KEY, {
    query: { enabled, staleTime: Number.POSITIVE_INFINITY, select: selectChoices },
  });
  return enabled ? data : undefined;
}

/** A custom tab holding a built-in's place in one conversation. */
export interface ReplacementHere {
  summary: PluginTabSummary;
  /** Cadencr brought the built-in back in this conversation. */
  fallback: boolean;
}

/**
 * The custom tabs replacing built-ins in this conversation, shown or set
 * aside for the built-in: what its tab strip and its "+" menu both show.
 */
export function useReplacementsHere(
  featureId: number,
  choices: TabReplacementChoices,
  summaries: readonly PluginTabSummary[] | undefined,
): ReadonlyMap<ReplaceableTab, ReplacementHere> {
  const fallbacks = useBuiltinFallbacks(featureId);
  return useMemo(() => {
    const resolved = resolveTabReplacements(choices, summaries, pluginTabsAvailable());
    return new Map(
      [...resolved].map(([slot, summary]) => [
        slot,
        { summary, fallback: slot in fallbacks && isSetAside(fallbacks, slot, summary.id) },
      ]),
    );
  }, [choices, fallbacks, summaries]);
}

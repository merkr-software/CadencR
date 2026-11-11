import { useEffect, useMemo, useRef, type ReactNode } from "react";
import type { TabContext } from "@cadencr/tab-sdk/protocol";

import { usePluginTabList, type PluginTabSummary } from "@/api/generated";
import type { FeatureTabDef } from "@/components/feature-layout/types";
import {
  forgetReplacedTabs,
  setReplacedTabs,
  type ReplacedTabs,
} from "@/lib/plugin-tabs/builtin-fallback";
import { rememberFeatureProject } from "@/lib/plugin-tabs/feature-projects";
import { pluginTabInstanceId } from "@/lib/plugin-tabs/instance-id";
import { clearInstanceState, usePluginTabRuntimeStore } from "@/lib/plugin-tabs/runtime-store";
import {
  hasTabReplacements,
  NO_TAB_REPLACEMENTS,
  type ReplaceableTab,
} from "@/lib/plugin-tabs/tab-replacements";
import {
  isPluginTabKind,
  pluginIdOfTab,
  pluginTabKind,
  type PluginTabKind,
  type TabKind,
} from "@/stores/feature-layout-schema";
import { selectFeatureLayout, useFeatureLayoutStore } from "@/stores/feature-layout-store";
import { getPluginTabs } from "@/stores/feature-layout-tree";

import { PluginTabAccessMark } from "./PluginTabAccess";
import { PluginTabIcon } from "./PluginTabIcon";
import { PluginTabView } from "./PluginTabView";
import {
  chosenReplacements,
  useReplacementsHere,
  useTabReplacementChoices,
} from "./tab-replacement";
import { usePluginTabContext, type PluginTabContextData } from "./usePluginTabContext";

export interface PluginTabDefs {
  /** Placed `plugin:<id>` tabs. */
  plugin: Partial<Record<PluginTabKind, FeatureTabDef>>;
  /** Custom tabs shown in place of built-ins (docs/CUSTOM_TABS.md §10). */
  replacements: Partial<Record<ReplaceableTab, FeatureTabDef>>;
}

const NO_DEFS: PluginTabDefs = { plugin: {}, replacements: {} };
/** Separates instance id and text in the badge selector's primitive key. */
const BADGE_SEPARATOR = "\u0000";

/**
 * The project's local custom tabs (shared query with the "+" menu). Never
 * stale on its own: `app/plugin_tab_changed` and every enablement write
 * invalidate it.
 */
export function useProjectPluginTabs(projectId: number, enabled: boolean) {
  return usePluginTabList(
    { project_id: projectId },
    { query: { enabled, staleTime: Number.POSITIVE_INFINITY } },
  );
}

/**
 * Plugin tabs placed in the feature's layout, joined into a string so the
 * selector result is a primitive (a fresh array per store update would
 * re-render every feature page on every layout write).
 */
export function usePlacedPluginTabsKey(featureId: number, enabled: boolean): string {
  return useFeatureLayoutStore((state) =>
    enabled ? getPluginTabs(selectFeatureLayout(featureId)(state).splitRoot).join("|") : "",
  );
}

/**
 * This feature's badges as one primitive (`instanceId \0 text` pairs): a
 * badge written by another feature's tab doesn't re-render this page.
 */
function useFeatureBadgesKey(featureId: number): string {
  const prefix = pluginTabInstanceId(featureId, "");
  return usePluginTabRuntimeStore((state) =>
    Object.entries(state.badges)
      .filter(([instanceId]) => instanceId.startsWith(prefix))
      .flat()
      .join(BADGE_SEPARATOR),
  );
}

function badgesOf(key: string): Map<string, string> {
  const parts = key === "" ? [] : key.split(BADGE_SEPARATOR);
  const badges = new Map<string, string>();
  for (let index = 0; index + 1 < parts.length; index += 2) {
    badges.set(parts[index]!, parts[index + 1]!);
  }
  return badges;
}

/**
 * A custom tab closed in this feature forgets its `state.*` (it otherwise
 * outlives guests and brokers on purpose). A move between panes keeps the
 * tab placed, so it keeps its state, and so does a tab still shown in place
 * of a built-in here: it is the same instance.
 */
function useForgetClosedTabState(featureId: number, placedKey: string, replacingKey: string): void {
  const previous = useRef({ featureId, placedKey });
  const replacing = useRef(replacingKey);
  replacing.current = replacingKey;
  useEffect(() => {
    const before = previous.current;
    previous.current = { featureId, placedKey };
    if (before.featureId !== featureId || before.placedKey === "") return;
    const placed = new Set(placedKey.split("|"));
    const kept = new Set(replacing.current.split("|"));
    for (const tab of before.placedKey.split("|") as TabKind[]) {
      const pluginId = pluginIdOfTab(tab);
      if (pluginId && !placed.has(tab) && !kept.has(pluginId))
        clearInstanceState(pluginTabInstanceId(featureId, pluginId));
    }
  }, [featureId, placedKey]);
}

function PluginTabBadge({ text }: { text: string }) {
  return <span className="font-mono text-[11px] tabular-nums text-primary">{text}</span>;
}

/** The tab's own badge, after the mark of a tab that runs commands or native code. */
function triggerBadge(summary: PluginTabSummary, text: string | undefined): ReactNode {
  const level = summary.access_level;
  if (level === "ui") return text ? <PluginTabBadge text={text} /> : undefined;
  return (
    <span className="inline-flex items-center gap-1">
      <PluginTabAccessMark level={level} />
      {text ? <PluginTabBadge text={text} /> : null}
    </span>
  );
}

function pluginTabDef(
  tab: TabKind,
  featureId: number,
  summary: PluginTabSummary,
  context: TabContext,
  badge: string | undefined,
): FeatureTabDef {
  return {
    label: summary.label,
    iconNode: <PluginTabIcon svg={summary.icon_svg} />,
    // A replacement holds a built-in's place, which is never closed.
    closable: isPluginTabKind(tab),
    badge: triggerBadge(summary, badge),
    content: <PluginTabView featureId={featureId} summary={summary} context={context} tab={tab} />,
  };
}

/** Built-in → custom tab as `git=vcs|…`, a primitive effect dependency. */
function replacedKey(replacements: Iterable<readonly [ReplaceableTab, PluginTabSummary]>): string {
  return [...replacements].map(([tab, summary]) => `${tab}=${summary.id}`).join("|");
}

function replacedOf(key: string): ReplacedTabs {
  return Object.fromEntries(key === "" ? [] : key.split("|").map((entry) => entry.split("=")));
}

/**
 * Records what this page replaces once it has read the setting and the
 * project's tabs (`null` before), so an action needing a built-in can bring
 * it back (`activateBuiltinFeatureTab`); forgotten when the page goes.
 */
function useRecordReplacedTabs(
  featureId: number,
  keys: { replaced: string; chosen: string } | null,
): void {
  const recorded = keys !== null;
  const replaced = keys?.replaced ?? "";
  const chosen = keys?.chosen ?? "";
  useEffect(() => {
    if (recorded) setReplacedTabs(featureId, replacedOf(replaced), replacedOf(chosen));
  }, [featureId, recorded, replaced, chosen]);
  useEffect(() => {
    if (recorded) return () => forgetReplacedTabs(featureId);
  }, [featureId, recorded]);
}

/**
 * Tab definitions for every custom tab placed in this feature's layout whose
 * plugin the project lists — valid or not, on or off: the tab body explains
 * an invalid or disabled tab, so the user can understand it and close it. A
 * placed tab whose plugin is gone has no definition and stays hidden (its
 * placement survives in the layout). Plus the custom tabs shown in place of
 * built-ins; a placed tab doing so is hidden from its own place, so one
 * conversation never runs it twice. Nothing is fetched for a feature with no
 * custom tab placed and no replacement chosen, nor derived where none shows.
 */
export function usePluginTabDefs({
  featureId,
  projectId,
  contextData,
  enabled,
}: {
  featureId: number;
  projectId: number;
  contextData: PluginTabContextData;
  enabled: boolean;
}): PluginTabDefs {
  const placedKey = usePlacedPluginTabsKey(featureId, enabled);
  const choices = useTabReplacementChoices(enabled);
  const chosen = choices !== undefined && hasTabReplacements(choices);
  const summaries = useProjectPluginTabs(projectId, placedKey !== "" || chosen).data;
  const here = useReplacementsHere(featureId, choices ?? NO_TAB_REPLACEMENTS, summaries);
  const replacingKey = [...here.values()].map(({ summary }) => summary.id).join("|");
  const settled = enabled && choices !== undefined && (!chosen || summaries !== undefined);
  const chosenKey = useMemo(
    () => replacedKey(chosenReplacements(choices ?? NO_TAB_REPLACEMENTS, summaries)),
    [choices, summaries],
  );
  useRecordReplacedTabs(
    featureId,
    settled
      ? {
          replaced: replacedKey([...here].map(([tab, { summary }]) => [tab, summary] as const)),
          chosen: chosenKey,
        }
      : null,
  );
  useForgetClosedTabState(featureId, placedKey, replacingKey);
  const needed = placedKey !== "" || here.size > 0;
  // The presence keeper needs it to tell whether these tabs may run while
  // this conversation is off screen.
  useEffect(() => {
    if (needed) rememberFeatureProject(featureId, projectId);
  }, [needed, featureId, projectId]);
  const context = usePluginTabContext(featureId, projectId, contextData, needed);
  const badgesKey = useFeatureBadgesKey(featureId);
  return useMemo(() => {
    if (!needed || !summaries) return NO_DEFS;
    const badges = badgesOf(badgesKey);
    const badgeOf = (pluginId: string) => badges.get(pluginTabInstanceId(featureId, pluginId));
    const defs: PluginTabDefs = { plugin: {}, replacements: {} };
    for (const tab of placedKey === "" ? [] : (placedKey.split("|") as TabKind[])) {
      const pluginId = pluginIdOfTab(tab);
      const summary = summaries.find((candidate) => candidate.id === pluginId);
      const replacing = [...here.values()].some(
        (entry) => !entry.fallback && entry.summary.id === pluginId,
      );
      if (!pluginId || !summary || replacing) continue;
      const kind = pluginTabKind(pluginId);
      defs.plugin[kind] = pluginTabDef(kind, featureId, summary, context, badgeOf(pluginId));
    }
    for (const [tab, { summary, fallback }] of here) {
      if (fallback) continue;
      defs.replacements[tab] = pluginTabDef(tab, featureId, summary, context, badgeOf(summary.id));
    }
    return defs;
  }, [badgesKey, context, featureId, here, needed, placedKey, summaries]);
}

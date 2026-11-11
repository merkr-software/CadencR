import { memo, useEffect, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import { useShallow } from "zustand/react/shallow";

import { getPluginTabListQueryOptions, type PluginTabSummary } from "@/api/generated";
import { pluginTabsAvailable } from "@/lib/plugin-tabs/availability";
import { PresenceRegistry, type WantedLease } from "@/lib/plugin-tabs/broker-presence";
import { usePluginTabFeatureProjects } from "@/lib/plugin-tabs/feature-projects";
import { pluginTabInstanceId } from "@/lib/plugin-tabs/instance-id";
import {
  hasTabReplacements,
  NO_TAB_REPLACEMENTS,
  type TabReplacementChoices,
} from "@/lib/plugin-tabs/tab-replacements";
import { pluginIdOfTab, type LayoutNode } from "@/stores/feature-layout-schema";
import { useFeatureLayoutStore } from "@/stores/feature-layout-store";
import { getPluginTabs } from "@/stores/feature-layout-tree";

import { staticOverlayState } from "./PluginTabView";
import { resolveTabReplacements, useTabReplacementChoices } from "./tab-replacement";

interface Placed {
  featureId: number;
  pluginId: string;
}

const NONE: readonly Placed[] = [];

/**
 * The custom tabs placed in one conversation, cached per split tree (and per
 * conversation: a default tree can be shared): a layout write leaves the other
 * conversations' trees, and so their entries, untouched.
 */
const placedByTree = new WeakMap<LayoutNode, Map<number, readonly Placed[]>>();

function placedIn(featureId: number, splitRoot: LayoutNode): readonly Placed[] {
  let byFeature = placedByTree.get(splitRoot);
  if (!byFeature) {
    byFeature = new Map();
    placedByTree.set(splitRoot, byFeature);
  }
  let placed = byFeature.get(featureId);
  if (!placed) {
    placed = getPluginTabs(splitRoot).flatMap((tab) => {
      const pluginId = pluginIdOfTab(tab);
      return pluginId ? [{ featureId, pluginId }] : [];
    });
    byFeature.set(featureId, placed);
  }
  return placed;
}

/**
 * Every custom tab placed in any conversation's tab strip. Entries are cached
 * objects, so under `useShallow` a layout write that moves no custom tab
 * leaves the result equal and the keeper does not re-render.
 */
export function selectPlacedPluginTabs(
  state: ReturnType<typeof useFeatureLayoutStore.getState>,
): Placed[] {
  return Object.entries(state.features).flatMap(([featureId, layout]) =>
    placedIn(Number(featureId), layout.splitRoot),
  );
}

/** A tab whose guest would run and which declares a backend — what the view used to lease. */
function runsBackend(summary: PluginTabSummary): boolean {
  return summary.backend != null && staticOverlayState(summary, true) === null;
}

/** Custom tabs shown in place of built-ins in each remembered conversation. */
function replacing(
  choices: TabReplacementChoices,
  projects: Readonly<Record<number, number>>,
  listOf: (projectId: number) => PluginTabSummary[] | undefined,
): Placed[] {
  if (!hasTabReplacements(choices)) return [];
  return Object.entries(projects).flatMap(([featureId, projectId]) =>
    [...resolveTabReplacements(choices, listOf(projectId), true).values()].map((summary) => ({
      featureId: Number(featureId),
      pluginId: summary.id,
    })),
  );
}

export function wantedLeases(
  placed: readonly Placed[],
  projects: Readonly<Record<number, number>>,
  listOf: (projectId: number) => PluginTabSummary[] | undefined,
  choices: TabReplacementChoices = NO_TAB_REPLACEMENTS,
): WantedLease[] {
  const leases = new Map<string, WantedLease>();
  for (const { featureId, pluginId } of [...placed, ...replacing(choices, projects, listOf)]) {
    const projectId = projects[featureId];
    const summary =
      projectId === undefined ? undefined : listOf(projectId)?.find((tab) => tab.id === pluginId);
    if (!summary || !runsBackend(summary)) continue;
    // Placed and replacing a built-in is still one instance.
    const instanceId = pluginTabInstanceId(featureId, pluginId);
    leases.set(instanceId, { instanceId, pluginId, featureId, name: summary.name });
  }
  return [...leases.values()];
}

/**
 * Holds the presence lease of every open custom tab with a backend, in every
 * conversation — not only the one on screen (docs/CUSTOM_TABS.md §4.7). The
 * guest view mounts and unmounts with its conversation page; the lease
 * follows the tab strip instead (`useFeatureLayoutStore`): taken when the tab
 * is placed (or its conversation's saved layout is first loaded after a
 * restart — the first visit, which comes before any backend use), released
 * when it is closed or its conversation deleted (`forgetFeatureProject`: the
 * deleted conversation's layout stays in the store; deleted from another
 * client, the service refuses its renewals instead), or once it may not run
 * (turned off, blocked, removed, invalid, no build for this platform). A tab
 * shown in place of a built-in (docs/CUSTOM_TABS.md §10) is held like a placed
 * one in every conversation whose page showed a custom tab.
 * Renders nothing; mount it once.
 */
export const PluginTabPresenceKeeper = memo(function PluginTabPresenceKeeper(): null {
  const desktop = pluginTabsAvailable();
  const everyPlaced = useFeatureLayoutStore(useShallow(selectPlacedPluginTabs));
  const projects = usePluginTabFeatureProjects((state) => state.projects);
  const choices = useTabReplacementChoices(desktop) ?? NO_TAB_REPLACEMENTS;
  const placed = desktop ? everyPlaced : NONE;
  const replaces = hasTabReplacements(choices);
  const projectIds = [
    ...new Set([
      ...placed.flatMap(({ featureId }) => projects[featureId] ?? []),
      ...(replaces ? Object.values(projects) : []),
    ]),
  ];
  // The very queries the conversation page lists its tabs with: one cache,
  // kept current by `app/plugin_tab_changed` and every enablement write.
  const lists = useQueries({
    queries: projectIds.map((projectId) =>
      getPluginTabListQueryOptions(
        { project_id: projectId },
        { query: { staleTime: Number.POSITIVE_INFINITY } },
      ),
    ),
  });
  const byProject = new Map(projectIds.map((projectId, index) => [projectId, lists[index]?.data]));
  const wanted = wantedLeases(placed, projects, (projectId) => byProject.get(projectId), choices);
  const wantedKey = wanted.map((lease) => lease.instanceId).join("|");
  const latest = useRef(wanted);
  latest.current = wanted;

  const registry = useRef<PresenceRegistry | null>(null);
  useEffect(() => {
    const owned = new PresenceRegistry();
    registry.current = owned;
    owned.sync(latest.current);
    return () => {
      owned.dispose();
      registry.current = null;
    };
  }, []);
  useEffect(() => {
    registry.current?.sync(latest.current);
  }, [wantedKey]);
  return null;
});

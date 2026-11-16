import { useMemo } from "react";
import { toast } from "sonner";
import {
  getGetWorkspaceSettingQueryKey,
  getListActiveFeaturesQueryOptions,
  setWorkspaceSettingsBatch,
  useGetWorkspaceSetting,
  type SettingValueResponse,
} from "@/api/generated";
import { parseIdList, readLoadedIdList, useIdListError } from "@/hooks/usePersistedIdSet";
import { seedSettingsFromBatch } from "@/hooks/useSidebarSettings";
import { apiErrorMessage } from "@/lib/api-errors";
import { applyOrder } from "@/lib/frozen-order";
import { queryClient } from "@/lib/queryClient";
import { parseSidebarOption, serializeSidebarOption, SIDEBAR_OPTIONS } from "@/lib/sidebar-config";
import { sortConversations, type ConversationSort } from "@/lib/sidebar-lens";
import {
  keyboardMoveTarget,
  NO_MANUAL_ORDER,
  placeInGroup,
  pruneManualOrder,
  SIDEBAR_CONVERSATION_ORDER_KEY as ORDER_KEY,
} from "@/lib/sidebar-manual-order";
import type { MoveConversation, MoveTarget } from "@/lib/sidebar-reorder-context";
import { useSidebarOption } from "@/stores/sidebar-config-store";

const SORT_KEY = SIDEBAR_OPTIONS.conversationSort.key;

/**
 * The sort as last saved, from the settings cache: the config store only
 * follows on the next render, too late for a move queued right behind the
 * one that switched to manual.
 */
function savedSort(): ConversationSort {
  const cached = queryClient.getQueryData<SettingValueResponse>(
    getGetWorkspaceSettingQueryKey(SORT_KEY),
  );
  return parseSidebarOption("conversationSort", cached?.value);
}

/**
 * The manual conversation order, read only under the manual sort (no other
 * sort uses it). From the settings cache, never stale on a timer: writes seed
 * the cache, the settings watcher refreshes it. A corrupt value says so once
 * and reads as empty; the next drag replaces it.
 */
export function useManualConversationOrder(): readonly number[] {
  const manual = useSidebarOption("conversationSort") === "manual";
  const { data } = useGetWorkspaceSetting(ORDER_KEY, {
    query: { staleTime: Infinity, enabled: manual },
  });
  const raw = data?.value;
  const parsed = useMemo(() => parseIdList(raw), [raw]);
  useIdListError(ORDER_KEY, parsed.error);
  return manual && !parsed.error ? parsed.ids : NO_MANUAL_ORDER;
}

/**
 * The order a move starts from. Under another sort, the first drag seeds it
 * so nothing but the dragged row moves. "Activity" seeds the dragged group
 * alone: every other row stays unranked, in the incoming order the lists
 * already show (the tree's frozen one). "Created" and "Title" seed every
 * active conversation as they sort them.
 */
async function baseOrder(group: readonly number[]): Promise<readonly number[] | null> {
  const sort = savedSort();
  if (sort === "manual") return readLoadedIdList(queryClient, ORDER_KEY);
  if (sort === "activity") return group;
  const active = await queryClient.ensureQueryData(getListActiveFeaturesQueryOptions());
  return sortConversations(active, sort, NO_MANUAL_ORDER).map((feature) => feature.id);
}

/** The settings a move writes, the sort switching to manual with it; null when nothing moves. */
async function settingsForMove(
  group: readonly number[],
  movedId: number,
  target: MoveTarget,
): Promise<Record<string, string> | null> {
  const base = await baseOrder(group);
  if (!base) return null;
  // The group as the saved order shows it, so a move queued behind another
  // (a held shortcut) starts from where the last one left its rows.
  const shown = applyOrder(
    group.map((id) => ({ id })),
    base,
  ).map(({ id }) => id);
  const drop =
    "direction" in target ? keyboardMoveTarget(shown, movedId, target.direction) : target;
  if (!drop) return null;
  const placed = placeInGroup(base, shown, movedId, drop.targetId, drop.position);
  if (placed === base) return null;
  const active = await queryClient.ensureQueryData(getListActiveFeaturesQueryOptions());
  const activeIds = new Set(active.map((feature) => feature.id));
  const values: Record<string, string> = {
    [ORDER_KEY]: JSON.stringify(pruneManualOrder(placed, activeIds, group)),
  };
  if (savedSort() !== "manual") {
    values[SORT_KEY] = serializeSidebarOption("manual");
  }
  return values;
}

async function saveMove(...args: Parameters<MoveConversation>): Promise<void> {
  try {
    const values = await settingsForMove(...args);
    if (!values) return;
    const saved = await setWorkspaceSettingsBatch({ values });
    seedSettingsFromBatch(queryClient, Object.keys(values), saved);
  } catch (error) {
    toast.error(`Could not reorder conversations: ${apiErrorMessage(error, "Unknown error")}`);
  }
}

let pendingMoves: Promise<void> = Promise.resolve();

/**
 * Moves a conversation within its group and saves the new manual order. No
 * optimistic update: rows move once the write confirms (instant locally),
 * when its response seeds the settings cache. Moves run one after another,
 * so a quick second drop or a held move shortcut reads the order the first
 * one saved instead of overwriting it. A failure says why.
 */
export const moveConversation: MoveConversation = (...args) => {
  pendingMoves = pendingMoves.then(() => saveMove(...args));
  return pendingMoves;
};

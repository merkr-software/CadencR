/**
 * When a "For me" entry leaves the list. Opening its conversation clears it by
 * default ("For me clears: On open"); with "When done", it stays until the
 * user marks it done (the row's check, the shortcut) or sends the
 * conversation a prompt, so the list reads as a to-do list rather than an
 * inbox. Either way, marking it done also dismisses its pull request action
 * until the pull request moves.
 */
import { useEffect } from "react";
import {
  getGetWorkspaceSettingQueryKey,
  useGetWorkspaceSetting,
  type SettingValueResponse,
} from "@/api/generated";
import { prActionKey } from "@/lib/next-actions";
import { queryClient } from "@/lib/queryClient";
import { parseSidebarOption, SIDEBAR_OPTIONS } from "@/lib/sidebar-config";
import { useUnreadStore } from "@/stores/unread-store";
import { usePrStatusStore } from "@/stores/usePrStatusStore";

const ACK_KEY = SIDEBAR_OPTIONS.forMeAck.key;

function clearsOnOpen(value: string | null | undefined): boolean {
  return parseSidebarOption("forMeAck", value) === "open";
}

/** The user is done with the conversation's For me entry, whatever it asks. */
export function acknowledgeForMe(featureId: number): void {
  const snapshot = usePrStatusStore.getState().byFeature[featureId];
  useUnreadStore.getState().acknowledge(featureId, prActionKey(snapshot));
}

/**
 * Whether opening a conversation clears its entry, read from the settings
 * cache outside React (an unloaded setting counts as the default).
 */
export function openingClearsForMe(): boolean {
  const cached = queryClient.getQueryData<SettingValueResponse>(
    getGetWorkspaceSettingQueryKey(ACK_KEY),
  );
  return clearsOnOpen(cached?.value);
}

/** The same, for React; null until the setting has loaded. */
function useOpeningClearsForMe(): boolean | null {
  const { data, isFetched } = useGetWorkspaceSetting(ACK_KEY, {
    query: { staleTime: Infinity },
  });
  return isFetched ? clearsOnOpen(data?.value) : null;
}

/**
 * Clear the unread flag whenever `featureId` is the open conversation, unless
 * For me clears only when done. Called at the ws-session route level so
 * opening a feature (by click, keyboard, or notification) reads it on every
 * device. Waits for the setting, so a restart in "When done" never reads the
 * conversation it reopens. Runs once per opening: marking the open
 * conversation unread by hand sticks until it is opened again.
 */
export function useMarkFeatureRead(featureId: number | null | undefined): void {
  const clears = useOpeningClearsForMe();
  useEffect(() => {
    if (featureId != null && clears) useUnreadStore.getState().markRead(featureId);
  }, [featureId, clears]);
}

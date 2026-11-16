import type { JsonValue } from "@cadencr/tab-sdk/protocol";
import { create } from "zustand";

/** A guest's request to open a link, waiting on the user's confirmation. */
export interface ExternalOpenRequest {
  id: number;
  instanceId: string;
  pluginName: string;
  url: string;
  resolve: (confirmed: boolean) => void;
}

interface PluginTabRuntimeState {
  /** `ui.setBadge` text per instance (absent = no badge). */
  badges: Record<string, string>;
  /** Pending `ui.openExternal` confirmations, oldest first. */
  externalOpens: ExternalOpenRequest[];
  /** The instance whose Activity dialog is open, if any. */
  activityOpen: string | null;
}

/**
 * Renderer-side state of live custom tabs that React renders: tab badges,
 * link confirmations and the open Activity dialog. Brokers and menus write
 * it; tab triggers and dialogs read it.
 */
export const usePluginTabRuntimeStore = create<PluginTabRuntimeState>(() => ({
  badges: {},
  externalOpens: [],
  activityOpen: null,
}));

/** Show what the tab ran in its conversation (`null` closes the dialog). */
export function setPluginTabActivityOpen(instanceId: string | null): void {
  usePluginTabRuntimeStore.setState({ activityOpen: instanceId });
}

export function setPluginTabBadge(instanceId: string, text: string | null): void {
  usePluginTabRuntimeStore.setState((state) => {
    if ((state.badges[instanceId] ?? null) === text) return state;
    const badges = { ...state.badges };
    if (text === null) delete badges[instanceId];
    else badges[instanceId] = text;
    return { badges };
  });
}

let nextExternalOpenId = 1;

export function hasPendingExternalOpen(instanceId: string): boolean {
  return usePluginTabRuntimeStore
    .getState()
    .externalOpens.some((entry) => entry.instanceId === instanceId);
}

/** Queue a confirmation; resolves with the user's answer. */
export function requestExternalOpen(
  request: Omit<ExternalOpenRequest, "id" | "resolve">,
): Promise<boolean> {
  return new Promise((resolve) => {
    const entry: ExternalOpenRequest = { ...request, id: nextExternalOpenId++, resolve };
    usePluginTabRuntimeStore.setState((state) => ({
      externalOpens: [...state.externalOpens, entry],
    }));
  });
}

/** Answer (and drop) a pending confirmation. */
export function settleExternalOpen(id: number, confirmed: boolean): void {
  const entry = usePluginTabRuntimeStore.getState().externalOpens.find((item) => item.id === id);
  if (!entry) return;
  usePluginTabRuntimeStore.setState((state) => ({
    externalOpens: state.externalOpens.filter((item) => item.id !== id),
  }));
  entry.resolve(confirmed);
}

/** A closed tab declines whatever it was still asking. */
export function releasePluginTabInstance(instanceId: string): void {
  for (const entry of usePluginTabRuntimeStore.getState().externalOpens) {
    if (entry.instanceId === instanceId) settleExternalOpen(entry.id, false);
  }
}

/**
 * `state.*` (§7): per-instance values in renderer memory, kept as their JSON
 * text (what the 1 MiB cap measures). Module-level on purpose — it outlives
 * brokers, so it survives the guest being reloaded, recycled under the
 * live-guest cap, or its tab being moved or re-opened. Dropped when the tab
 * is closed (`clearInstanceState`).
 */
const instanceState = new Map<string, string>();

export function readInstanceState(instanceId: string): JsonValue {
  const text = instanceState.get(instanceId);
  return text === undefined ? null : (JSON.parse(text) as JsonValue);
}

export function writeInstanceState(instanceId: string, json: string): void {
  if (json === "null") instanceState.delete(instanceId);
  else instanceState.set(instanceId, json);
}

export function clearInstanceState(instanceId: string): void {
  instanceState.delete(instanceId);
}

import { toastError } from "@/lib/api-errors";
import { createLeadingSettleCoalescer } from "@/lib/coalesceInvalidation";
import { invalidateByUrlPrefix, queryClient } from "@/lib/queryClient";

/** Controls a mounted custom tab exposes to code outside its view. */
export interface LiveInstanceControls {
  pluginId: string;
  /** User-requested reload: shows the loading state until the guest is back. */
  reload: () => void;
  /** The plugin changed on disk: fresh grant + reload, keeping the current view. */
  refresh: () => void;
}

const liveInstances = new Map<string, LiveInstanceControls>();

export function registerLivePluginTab(
  instanceId: string,
  controls: LiveInstanceControls,
): () => void {
  liveInstances.set(instanceId, controls);
  return () => {
    if (liveInstances.get(instanceId) === controls) liveInstances.delete(instanceId);
  };
}

/** Reload one mounted tab; `false` when it is not running. */
export function reloadLivePluginTab(instanceId: string): boolean {
  const controls = liveInstances.get(instanceId);
  controls?.reload();
  return controls !== undefined;
}

/** Refetch every plugin-tab read: the list, one tab, its configuration. */
export function refreshPluginTabReads(): Promise<void> {
  return invalidateByUrlPrefix(queryClient, ["/api/plugin-tabs", "/api/marketplace/tabs"]);
}

/** `refreshPluginTabReads` for a user's "Reload": a failure is a toast. */
export function refreshPluginTabsOrToast(): void {
  refreshPluginTabReads().catch((error: unknown) =>
    toastError(error, "Custom tabs could not be refreshed"),
  );
}

/** Plugins changed since the last flush; `null` = any plugin (a lagged subscriber). */
let changedPlugins: Set<string> | null = new Set();

function flushPluginTabChanges(): void {
  const changed = changedPlugins;
  changedPlugins = new Set();
  void refreshPluginTabReads();
  for (const controls of liveInstances.values()) {
    if (changed === null || changed.has(controls.pluginId)) controls.refresh();
  }
}

/**
 * A `vite build --watch` rewrites `dist/` over more than the service's 250 ms
 * per-tab debounce, and several plugins can change together: run the first
 * event at once, then fold a burst into one trailing refetch + reload.
 */
const pluginTabChangeCoalescer = createLeadingSettleCoalescer(flushPluginTabChanges, 300);

/**
 * `app/plugin_tab_changed` (the service's watcher saw `tab.json`, `icon.svg`
 * or `dist/` change): refetch the tab reads — validity, label, icon and
 * enablement may have moved — and reload the live instances of that plugin.
 * An empty payload (a lagged subscriber) means "anything may have changed".
 */
export function handlePluginTabChanged(payload: Record<string, unknown>): void {
  const pluginId = typeof payload.plugin_id === "string" ? payload.plugin_id : null;
  if (pluginId === null) changedPlugins = null;
  else changedPlugins?.add(pluginId);
  pluginTabChangeCoalescer.trigger();
}

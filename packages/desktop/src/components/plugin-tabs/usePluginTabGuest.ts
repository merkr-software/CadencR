import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import type { TabContext } from "@cadencr/tab-sdk/protocol";

import { createBrowserViewportBoundsTracker } from "@/components/useBrowserViewportBounds";
import { apiErrorMessage } from "@/lib/api-errors";
import { desktopBridge } from "@/lib/desktop-bridge";
import { PluginTabBroker } from "@/lib/plugin-tabs/broker";
import type { PluginIdentity } from "@/lib/plugin-tabs/broker-runtime";
import { registerLivePluginTab, reloadLivePluginTab } from "@/lib/plugin-tabs/live-instances";
import { ensurePluginTabThemeSync } from "@/lib/plugin-tabs/theme-sync";
import type { PluginTabEventType, PluginTabOwnShortcut } from "@/shared/plugin-tab-host";

/** Where the guest view of a live instance stands. */
export type GuestPhase =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "recycled" }
  | { kind: "failed"; detail: string | null }
  | { kind: "crashed"; detail: string | null };

const LOADING: GuestPhase = { kind: "loading" };

/** The phase a lifecycle event moves the guest to. */
function phaseOf(
  type: Exclude<PluginTabEventType, "shortcut">,
  detail: string | undefined,
): GuestPhase {
  switch (type) {
    case "loaded":
      return { kind: "ready" };
    case "load-failed":
      return { kind: "failed", detail: detail ?? null };
    case "crashed":
      return { kind: "crashed", detail: detail ?? null };
    case "recycled":
      return { kind: "recycled" };
  }
}

/**
 * Bridge failures are rare (an IPC to a main process that is always there)
 * but must be visible; one toast id keeps a per-frame call (bounds) from
 * stacking a toast per frame.
 */
function reportBridgeError(error: unknown, what: string): void {
  toast.error(`Custom tab: ${what}`, {
    id: "plugin-tab-bridge",
    description: apiErrorMessage(error, "The desktop shell did not answer"),
  });
}

export interface PluginTabGuestOptions {
  instanceId: string;
  featureId: number;
  plugin: PluginIdentity;
  context: TabContext;
  /** Whether a guest should run at all (desktop, valid, on, built). */
  live: boolean;
  /** The tab is its pane's active tab and the window is visible. */
  visible: boolean;
  /** The placeholder element the native view is laid over. */
  placeholder: HTMLDivElement | null;
  /** The tab's active `tab.json` shortcuts (`plugin.shortcuts` names their ids). */
  shortcuts: readonly PluginTabOwnShortcut[];
}

export interface PluginTabGuest {
  phase: GuestPhase;
  reload: () => void;
}

interface StartGuestArgs {
  instanceId: string;
  featureId: number;
  pluginId: string;
  initial: { plugin: PluginIdentity; context: TabContext; visible: boolean };
  setPhase: (phase: GuestPhase) => void;
  brokerRef: RefObject<PluginTabBroker | null>;
}

/** Open the guest with its broker; returns the teardown (broker + `close`). */
function startGuest({
  instanceId,
  featureId,
  pluginId,
  initial,
  setPhase,
  brokerRef,
}: StartGuestArgs): () => void {
  const bridge = desktopBridge.pluginTabs;
  ensurePluginTabThemeSync();
  const broker = new PluginTabBroker({ instanceId, featureId, ...initial });
  brokerRef.current = broker;
  setPhase(LOADING);
  const offEvents = bridge.onEvent((event) => {
    if (event.instanceId !== instanceId) return;
    if (event.type === "shortcut") {
      if (event.detail !== undefined) broker.pressShortcut(event.detail);
      return;
    }
    // The page is gone (destroyed under the live-guest cap, crashed, or never
    // loaded): free its socket, subscriptions and grant until a new page
    // brings a new port.
    if (event.type !== "loaded") broker.suspend();
    setPhase(phaseOf(event.type, event.detail));
  });
  const reloadGuest = (): void => {
    void bridge.reload(instanceId).catch((error: unknown) => {
      setPhase({ kind: "failed", detail: apiErrorMessage(error, "Reload failed") });
    });
  };
  const offLive = registerLivePluginTab(instanceId, {
    pluginId,
    reload: () => {
      setPhase(LOADING);
      reloadGuest();
    },
    refresh: () => {
      // The service revoked the grant along with the change.
      broker.resetGrant();
      reloadGuest();
    },
  });
  void bridge.open(instanceId, pluginId).catch((error: unknown) => {
    setPhase({ kind: "failed", detail: apiErrorMessage(error, "The tab could not be opened") });
  });
  return () => {
    offLive();
    offEvents();
    brokerRef.current = null;
    broker.dispose();
    void bridge
      .close(instanceId)
      .catch((error: unknown) => reportBridgeError(error, "close failed"));
  };
}

/**
 * Lifecycle of one guest (docs/CUSTOM_TABS.md §5): broker, `open`/`close`,
 * host events, bounds over the placeholder and visibility. The native view
 * is shown only once its page has loaded — until then (and after a failure)
 * the placeholder's overlay is what the user sees.
 */
export function usePluginTabGuest(options: PluginTabGuestOptions): PluginTabGuest {
  const { instanceId, featureId, plugin, context, live, visible, placeholder, shortcuts } = options;
  const [phase, setPhase] = useState<GuestPhase>(LOADING);
  const brokerRef = useRef<PluginTabBroker | null>(null);
  const latest = useRef({ plugin, context, visible });
  latest.current = { plugin, context, visible };
  const pluginId = plugin.id;

  useEffect(() => {
    if (!live) return;
    return startGuest({
      instanceId,
      featureId,
      pluginId,
      initial: latest.current,
      setPhase,
      brokerRef,
    });
  }, [featureId, instanceId, live, pluginId]);

  useEffect(() => {
    brokerRef.current?.setContext(context);
  }, [context]);

  useEffect(() => {
    brokerRef.current?.setPlugin(plugin);
  }, [plugin]);

  // Matched in the main process, which forgets them when the guest closes.
  useEffect(() => {
    if (!live) return;
    void desktopBridge.pluginTabs
      .setTabShortcuts(instanceId, shortcuts)
      .catch((error: unknown) => reportBridgeError(error, "its shortcuts could not be set"));
  }, [instanceId, live, shortcuts]);

  // Over the live-guest cap a hidden guest is destroyed; showing it again
  // recreates it.
  const recycled = phase.kind === "recycled";
  useEffect(() => {
    if (!live || !visible || !recycled) return;
    setPhase(LOADING);
    void desktopBridge.pluginTabs.open(instanceId, pluginId).catch((error: unknown) => {
      setPhase({ kind: "failed", detail: apiErrorMessage(error, "The tab could not be reopened") });
    });
  }, [instanceId, live, pluginId, recycled, visible]);

  // Only while shown: a hidden guest needs no bounds, and the tracker's
  // window scroll listener would force a layout per scroll for every one.
  // `attach` syncs at once, so bounds are fresh as soon as the tab shows.
  useEffect(() => {
    if (!live || !visible || !placeholder) return;
    const tracker = createBrowserViewportBoundsTracker({
      onBounds: (bounds) => {
        void desktopBridge.pluginTabs
          .setBounds(instanceId, bounds)
          .catch((error: unknown) => reportBridgeError(error, "layout failed"));
      },
    });
    tracker.attach(placeholder);
    return () => tracker.dispose();
  }, [instanceId, live, placeholder, visible]);

  const shown = live && visible && phase.kind === "ready";
  useEffect(() => {
    if (!live) return;
    void desktopBridge.pluginTabs
      .setVisible(instanceId, shown)
      .catch((error: unknown) => reportBridgeError(error, "show/hide failed"));
  }, [instanceId, live, shown]);

  useEffect(() => {
    brokerRef.current?.setVisible(live && visible);
  }, [live, visible]);

  const reload = useCallback(() => {
    reloadLivePluginTab(instanceId);
  }, [instanceId]);

  return useMemo(() => ({ phase, reload }), [phase, reload]);
}

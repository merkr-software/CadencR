import { desktopBridge } from "@/lib/desktop-bridge";
import type { PluginTabBroker } from "@/lib/plugin-tabs/broker";
import { editorSurfaces } from "./editor-surfaces";

/** A reload withdraws availability until the new guest completes its handshake. */
export function mountedEditorSurface(instanceId: string, broker: () => PluginTabBroker) {
  let release: (() => void) | undefined;
  const connectionChanged = (connected: boolean): void => {
    release?.();
    release = connected
      ? editorSurfaces.register(instanceId, {
          requestBackend: (method, params) => broker().requestBackend(method, params),
          focus: () => desktopBridge.pluginTabs.focus(instanceId),
        })
      : undefined;
  };
  return { connectionChanged, dispose: () => connectionChanged(false) };
}

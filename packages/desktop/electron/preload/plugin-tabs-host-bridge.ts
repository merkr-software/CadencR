import { ipcRenderer, webFrame } from "electron";
import type { OnIpc } from "./notch-host-bridge";
import {
  PLUGIN_TAB_APP_SHORTCUT_CHANNEL,
  PLUGIN_TAB_EVENT_CHANNEL,
  PLUGIN_TAB_PORT_MESSAGE_TYPE,
  PLUGIN_TAB_RENDERER_PORT_CHANNEL,
  type PluginTabEvent,
  type PluginTabKeyInput,
  type PluginTabPortMessage,
  type PluginTabsBridge,
} from "../../src/shared/plugin-tab-host";

/**
 * Forward each instance's broker port from the main process to the renderer's
 * main world. `contextBridge` can't carry a MessagePort, so it rides on
 * `window.postMessage` (Electron's "MessagePorts in Electron" pattern); the
 * renderer filters on `event.source === window` and the message type.
 */
export function installPluginTabPortRelay(): void {
  ipcRenderer.on(PLUGIN_TAB_RENDERER_PORT_CHANNEL, (event, payload: { instanceId: string }) => {
    const message: PluginTabPortMessage = {
      type: PLUGIN_TAB_PORT_MESSAGE_TYPE,
      instanceId: payload.instanceId,
    };
    // Packaged builds load from file://, whose origin serializes as "null".
    const origin = window.location.origin === "null" ? "*" : window.location.origin;
    window.postMessage(message, origin, event.ports);
  });
}

/** The renderer's control surface over custom-tab guest views. */
export function pluginTabsHostBridge(onIpc: OnIpc): { pluginTabs: PluginTabsBridge } {
  return {
    pluginTabs: {
      open: (instanceId, pluginId, surface) =>
        ipcRenderer.invoke("plugin-tab:open", instanceId, pluginId, surface),
      // Zoomed CSS px from getBoundingClientRect: read the zoom factor here so
      // it matches the layout just measured (same reasoning as setBrowserBounds).
      setBounds: (instanceId, bounds) =>
        ipcRenderer.invoke("plugin-tab:set-bounds", instanceId, bounds, webFrame.getZoomFactor()),
      setVisible: (instanceId, visible) =>
        ipcRenderer.invoke("plugin-tab:set-visible", instanceId, visible),
      reload: (instanceId) => ipcRenderer.invoke("plugin-tab:reload", instanceId),
      close: (instanceId) => ipcRenderer.invoke("plugin-tab:close", instanceId),
      openDevTools: (instanceId) => ipcRenderer.invoke("plugin-tab:open-devtools", instanceId),
      focus: (instanceId) => ipcRenderer.invoke("plugin-tab:focus", instanceId),
      setTheme: (theme) => ipcRenderer.invoke("plugin-tab:set-theme", theme),
      setAppShortcuts: (bindings) => ipcRenderer.invoke("plugin-tab:set-app-shortcuts", bindings),
      setTabShortcuts: (instanceId, shortcuts) =>
        ipcRenderer.invoke("plugin-tab:set-tab-shortcuts", instanceId, shortcuts),
      onEvent: (cb) => onIpc<PluginTabEvent>(PLUGIN_TAB_EVENT_CHANNEL, cb),
      onAppShortcut: (cb) => onIpc<PluginTabKeyInput>(PLUGIN_TAB_APP_SHORTCUT_CHANNEL, cb),
    },
  };
}

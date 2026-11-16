import { contextBridge, ipcRenderer } from "electron";
import type { NotchBridge } from "../../src/shared/notch";

/**
 * Preload of the notch island window. Deliberately tiny and self-contained:
 * the island only draws what the app renderer composed, so it gets none of
 * the main window's privileges — and a sandboxed preload can't load a chunk
 * shared with the main preload, so nothing here may import local modules
 * (type-only imports are erased).
 */
function onIpc<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const bridge: NotchBridge = {
  ready: () => ipcRenderer.invoke("notch:ready"),
  setHotRect: (rect) => ipcRenderer.invoke("notch:hot-rect", rect),
  openFeature: (ref) => ipcRenderer.invoke("notch:open-feature", ref),
  dismiss: (ref) => ipcRenderer.invoke("notch:dismiss", ref),
  collapse: () => ipcRenderer.invoke("notch:collapse"),
  snooze: (minutes) => ipcRenderer.invoke("notch:snooze", minutes),
  onSnapshot: (cb) => onIpc("notch:snapshot", cb),
  onNotification: (cb) => onIpc("notch:notification", cb),
  onHover: (cb) => onIpc("notch:hover", cb),
  onGeometry: (cb) => onIpc("notch:geometry", cb),
  onPrefs: (cb) => onIpc("notch:prefs", cb),
  onSnooze: (cb) => onIpc("notch:snoozed", cb),
};

contextBridge.exposeInMainWorld("cadencrNotch", bridge);

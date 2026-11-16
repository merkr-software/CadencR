import { ipcRenderer } from "electron";
import type {
  NotchCapabilities,
  NotchConfig,
  NotchFeatureRef,
  NotchNotification,
  NotchSnapshot,
} from "../../src/shared/notch";

export type OnIpc = <T>(channel: string, cb: (payload: T) => void) => () => void;

/** The app renderer's side of the notch island: it feeds state in, the island draws it. */
export function notchHostBridge(onIpc: OnIpc) {
  return {
    notchCapabilities: (): Promise<NotchCapabilities> => ipcRenderer.invoke("notch:capabilities"),
    notchConfigure: (config: NotchConfig): Promise<void> =>
      ipcRenderer.invoke("notch:configure", config),
    notchPushSnapshot: (snapshot: NotchSnapshot): Promise<void> =>
      ipcRenderer.invoke("notch:snapshot", snapshot),
    notchNotify: (notification: NotchNotification): Promise<void> =>
      ipcRenderer.invoke("notch:notify", notification),
    onNotchDismissed: (cb: (ref: NotchFeatureRef) => void): (() => void) =>
      onIpc("notch:dismissed", cb),
  };
}

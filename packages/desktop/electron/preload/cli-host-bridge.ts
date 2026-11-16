import { ipcRenderer } from "electron";
import type {
  CliInstallOptions,
  CliInstallStatus,
  CliRendererItem,
} from "../../src/shared/cli-bridge";
import type { OnIpc } from "./notch-host-bridge";

/** The `cadencr` command line: its pending requests, and installing it on PATH. */
export function cliHostBridge(onIpc: OnIpc) {
  return {
    drainCliRequests: (): Promise<CliRendererItem[]> => ipcRenderer.invoke("cli:drain-requests"),
    onCliRequestsPending: (cb: () => void): (() => void) =>
      onIpc<void>("cli:requests-pending", () => cb()),
    cliInstallStatus: (): Promise<CliInstallStatus> => ipcRenderer.invoke("cli:install-status"),
    installCli: (options: CliInstallOptions): Promise<CliInstallStatus> =>
      ipcRenderer.invoke("cli:install", options),
    uninstallCli: (): Promise<CliInstallStatus> => ipcRenderer.invoke("cli:uninstall"),
  };
}

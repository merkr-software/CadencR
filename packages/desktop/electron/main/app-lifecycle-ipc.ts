import { ipcMain, type BrowserWindow } from "electron";
import { parseAppCloseChoice, type AppCloseChoice } from "../../src/shared/app-close";
import type { ServiceStatus } from "../../src/shared/service-status";
import { assertTrustedSender } from "./ipc";

/** The close confirmation, owned by main (see `close-coordinator`). */
export interface AppCloseIpc {
  confirm: (choice: AppCloseChoice) => void;
  acknowledge: () => void;
  cancel: () => void;
  requestQuit: () => void;
}

export interface ServiceIpc {
  status: () => ServiceStatus;
  restart: () => Promise<void>;
}

export interface AppLifecycleIpcOptions {
  getMainWindow: () => BrowserWindow | null;
  appClose: AppCloseIpc;
  service: ServiceIpc;
}

/** Quitting, closing and the service's life: every channel the main window answers. */
export function registerAppLifecycleIpc({
  getMainWindow,
  appClose,
  service,
}: AppLifecycleIpcOptions): void {
  const handle = (channel: string, run: (arg: unknown) => unknown): void => {
    ipcMain.handle(channel, (event, arg: unknown) => {
      assertTrustedSender(event, getMainWindow);
      return run(arg);
    });
  };
  handle("app:confirm-close", (choice) => appClose.confirm(parseAppCloseChoice(choice)));
  handle("app:acknowledge-close", () => appClose.acknowledge());
  handle("app:cancel-close", () => appClose.cancel());
  handle("app:request-quit", () => appClose.requestQuit());
  handle("service:status", () => service.status());
  handle("service:restart", () => service.restart());
}

import { ipcMain, type BrowserWindow } from "electron";
import { z } from "zod";
import type { ServiceStatus } from "../../src/shared/service-status";
import { assertTrustedSender } from "./ipc";

/** The close confirmation, owned by main (see `close-coordinator`). */
export interface AppCloseIpc {
  confirm: (id: number) => Promise<void> | void;
  acknowledge: (id: number) => void;
  cancel: (id: number) => void;
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
  const requestId = z.number().int().positive();
  handle("app:confirm-close", (id) => appClose.confirm(requestId.parse(id)));
  handle("app:acknowledge-close", (id) => appClose.acknowledge(requestId.parse(id)));
  handle("app:cancel-close", (id) => appClose.cancel(requestId.parse(id)));
  handle("app:request-quit", () => appClose.requestQuit());
  handle("service:status", () => service.status());
  handle("service:restart", () => service.restart());
}

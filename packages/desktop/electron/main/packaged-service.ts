import type { ServiceStatus } from "../../src/shared/service-status";
import {
  spawnProductionSidecar,
  type BrowserBridgeSidecarEnv,
  type SidecarHandle,
  type SidecarStatusUpdate,
} from "./sidecar";
import { createServiceSupervisor, type ServiceSupervisor } from "./service-supervisor";

export interface PackagedServiceHost {
  appVersion: string;
  browserBridge: () => BrowserBridgeSidecarEnv | undefined;
  /** A quit is under way: a service started now must not outlive the app. */
  shuttingDown: () => boolean;
  /** Make a freshly started service the one the app talks to. */
  adopt: (handle: SidecarHandle) => Promise<void>;
  publish: (status: ServiceStatus) => void;
}

export interface PackagedService {
  spawn: (onStatus?: (update: SidecarStatusUpdate) => void) => Promise<SidecarHandle>;
  supervisor: ServiceSupervisor;
}

/** The packaged sidecar and its supervision; the dev service runs on its own. */
export function createPackagedService(host: PackagedServiceHost): PackagedService {
  const spawn = (onStatus?: (update: SidecarStatusUpdate) => void): Promise<SidecarHandle> =>
    spawnProductionSidecar({
      appVersion: host.appVersion,
      browserBridge: host.browserBridge(),
      onStatus,
      onUnexpectedExit: (exit) => supervisor.reportExit(exit),
    });
  const supervisor = createServiceSupervisor({
    respawn: async () => {
      const next = await spawn();
      if (host.shuttingDown()) {
        await next.stop();
        throw new Error("Cadencr is shutting down.");
      }
      try {
        await host.adopt(next);
      } catch (error) {
        // Not adopted means not reachable: stop it rather than leave a live
        // service holding the port while the window reports it down.
        await next.stop();
        throw error;
      }
    },
    publish: host.publish,
  });
  return { spawn, supervisor };
}

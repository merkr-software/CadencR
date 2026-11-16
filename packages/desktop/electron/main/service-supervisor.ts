import type { ServiceStatus } from "../../src/shared/service-status";
import type { SidecarExit } from "./sidecar";

export interface ServiceSupervisorOptions {
  /** Start a new service and make it the one the app talks to. */
  respawn: () => Promise<void>;
  /** Tell the window; it may be gone, in which case it re-reads `status()`. */
  publish: (status: ServiceStatus) => void;
}

export interface ServiceSupervisor {
  status: () => ServiceStatus;
  /** The running service died on its own. */
  reportExit: (exit: SidecarExit) => void;
  /**
   * User-requested restart of a service that is down. A failed attempt is
   * published as `down` with its reason; only a refused one (already
   * running or restarting, app shutting down) rejects.
   */
  restart: () => Promise<void>;
  /** The app is shutting down: exits from here on are expected. */
  stopSupervising: () => void;
}

/**
 * One owner for "is the service up?" once startup is over. A dead service is
 * never restarted behind the user's back (a crash loop would hide the cause);
 * the window shows why it stopped and offers the restart.
 */
export function createServiceSupervisor(options: ServiceSupervisorOptions): ServiceSupervisor {
  let status: ServiceStatus = { state: "running" };
  let supervising = true;
  const set = (next: ServiceStatus): void => {
    status = next;
    options.publish(next);
  };
  return {
    status: () => status,
    reportExit: (exit) => {
      if (!supervising) return;
      set({ state: "down", detail: exit.detail || "The service stopped unexpectedly." });
    },
    restart: async () => {
      if (!supervising) throw new Error("Cadencr is shutting down.");
      if (status.state !== "down") {
        throw new Error(
          status.state === "restarting"
            ? "The service is already restarting."
            : "The service is already running.",
        );
      }
      set({ state: "restarting" });
      try {
        await options.respawn();
      } catch (error) {
        // Published, not thrown: the window shows why from the status, and a
        // rejection on top would report the same failure a second time.
        const message = error instanceof Error ? error.message : String(error);
        if (supervising) set({ state: "down", detail: message });
        return;
      }
      if (supervising) set({ state: "running" });
    },
    stopSupervising: () => {
      supervising = false;
    },
  };
}

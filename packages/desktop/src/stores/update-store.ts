import { create } from "zustand";
import { desktopBridge } from "@/lib/desktop-bridge";
import { toastError } from "@/lib/api-errors";
import { INITIAL_UPDATE_SNAPSHOT, type UpdateSnapshot } from "@/shared/update-state";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { countWorkingSessions, isLiveStatusKnown } from "@/stores/session-status-selectors";

/**
 * The renderer's mirror of the main process's update state. Its updater
 * fields — the wish to install once agents finish included — change only
 * through `receive`, with a snapshot the main process published
 * (`useAutoUpdateBridge`) or returned from a request.
 */
interface UpdateState extends UpdateSnapshot {
  /** A request to set or clear the install-when-agents-finish wish is in flight. */
  installWishPending: boolean;
  /** Starts a check. Rejects when the main process could not be asked. */
  checkForUpdates: () => Promise<void>;
  installUpdate: () => Promise<void>;
  /** Ask the main process to install once no agent is working (at once if none is). */
  scheduleInstallWhenAgentsFinish: () => Promise<void>;
  cancelInstallWhenAgentsFinish: () => Promise<void>;
  /** Adopt a main-process snapshot unless a newer one is already held. */
  receive: (snapshot: UpdateSnapshot) => void;
}

export const useUpdateStore = create<UpdateState>((set, get) => {
  const requestInstallWish = async (pending: boolean): Promise<void> => {
    set({ installWishPending: true });
    try {
      get().receive(await desktopBridge.setInstallWhenAgentsFinish(pending));
    } catch (err) {
      toastError(err, pending ? "Could not schedule the update." : "Could not cancel the update.");
    } finally {
      set({ installWishPending: false });
    }
  };
  return {
    ...INITIAL_UPDATE_SNAPSHOT,
    installWishPending: false,
    checkForUpdates: async () => {
      get().receive(await desktopBridge.checkForUpdates());
    },
    installUpdate: async () => {
      try {
        // The main process settles a pending install wish as the install starts.
        await desktopBridge.installUpdate();
      } catch (err) {
        // The main process also records an install failure in the update state.
        toastError(err, "Could not install the update.");
      }
    },
    scheduleInstallWhenAgentsFinish: () => requestInstallWish(true),
    cancelInstallWhenAgentsFinish: () => requestInstallWish(false),
    receive: (snapshot) => {
      // Pushes and the mount-time read can cross: never step back to an older state.
      if (snapshot.revision <= get().revision) return;
      set(snapshot);
    },
  };
});

let installing = false;

/** The wish holds, the update is ready, and the live status shows no agent working. */
function agentsFinished(): boolean {
  const update = useUpdateStore.getState();
  if (!update.installWhenAgentsFinish || update.status !== "downloaded") return false;
  const status = useSessionStatusStore.getState();
  // After a reload, or while the status socket is down, "no agent working" is unknown.
  return isLiveStatusKnown(status) && countWorkingSessions(status.bySession) === 0;
}

function installIfAgentsFinished(): void {
  if (installing || !agentsFinished()) return;
  installing = true;
  void useUpdateStore
    .getState()
    .installUpdate()
    .finally(() => {
      installing = false;
    });
}

/**
 * Starts the install the main process is waiting for once the last agent
 * finishes, including after a renderer reload. Plain store subscriptions, not
 * a React hook: a root-level component subscribed to every status change
 * would re-render the whole app shell. Returns the unsubscribe.
 */
export function followInstallWhenAgentsFinish(): () => void {
  const stopUpdates = useUpdateStore.subscribe(installIfAgentsFinished);
  const stopStatus = useSessionStatusStore.subscribe(installIfAgentsFinished);
  installIfAgentsFinished();
  return () => {
    stopUpdates();
    stopStatus();
  };
}

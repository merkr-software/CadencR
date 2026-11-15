import { create } from "zustand";
import { desktopBridge } from "@/lib/desktop-bridge";
import { toastError } from "@/lib/api-errors";
import { INITIAL_UPDATE_SNAPSHOT, type UpdateSnapshot } from "@/shared/update-state";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { countWorkingSessions } from "@/stores/session-status-selectors";

/**
 * The renderer's mirror of the main process's update state. Its updater
 * fields change only through `receive`, with a snapshot the main process
 * published (`useAutoUpdateBridge`) or returned from a check.
 */
interface UpdateState extends UpdateSnapshot {
  /**
   * The user asked to install once no agent is mid-turn. Cleared when the
   * install starts or the user cancels. Renderer-side: it waits on the
   * renderer's live agent status.
   */
  installWhenAgentsFinish: boolean;
  /** Starts a check. Rejects when the main process could not be asked. */
  checkForUpdates: () => Promise<void>;
  installUpdate: () => Promise<void>;
  /** Install now if no agent is working, else as soon as the last one finishes. */
  scheduleInstallWhenAgentsFinish: () => void;
  cancelInstallWhenAgentsFinish: () => void;
  /** Adopt a main-process snapshot unless a newer one is already held. */
  receive: (snapshot: UpdateSnapshot) => void;
}

/**
 * Watches live agent status while an install waits for agents to finish.
 * A plain store subscription, not a React hook: a root-level component
 * subscribed to every status change would re-render the whole app shell.
 */
let stopWatchingAgents: (() => void) | null = null;

function stopAgentWatch(): void {
  stopWatchingAgents?.();
  stopWatchingAgents = null;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  ...INITIAL_UPDATE_SNAPSHOT,
  installWhenAgentsFinish: false,
  checkForUpdates: async () => {
    get().receive(await desktopBridge.checkForUpdates());
  },
  installUpdate: async () => {
    stopAgentWatch();
    set({ installWhenAgentsFinish: false });
    try {
      await desktopBridge.installUpdate();
    } catch (err) {
      // The main process also records an install failure in the update state.
      toastError(err, "Could not install the update.");
    }
  },
  scheduleInstallWhenAgentsFinish: () => {
    const idle = (): boolean =>
      countWorkingSessions(useSessionStatusStore.getState().bySession) === 0;
    if (idle()) {
      void get().installUpdate();
      return;
    }
    stopAgentWatch();
    stopWatchingAgents = useSessionStatusStore.subscribe(() => {
      if (idle()) void get().installUpdate();
    });
    set({ installWhenAgentsFinish: true });
  },
  cancelInstallWhenAgentsFinish: () => {
    stopAgentWatch();
    set({ installWhenAgentsFinish: false });
  },
  receive: (snapshot) => {
    // Pushes and the mount-time read can cross: never step back to an older state.
    if (snapshot.revision <= get().revision) return;
    set(snapshot);
  },
}));

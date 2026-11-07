/**
 * Counts sessions the backend reports mid-turn and forwards a debounced
 * boolean to the Electron main process. Main ref-counts
 * `powerSaveBlocker('prevent-app-suspension')` off that signal.
 *
 * Reads the status book, not conversation lifecycles: an agent started by a
 * schedule, MCP, or another device must hold the blocker too, even when no
 * conversation is loaded in this window. Provider-neutral.
 */

import { useEffect, useRef } from "react";
import { apiErrorMessage } from "@/lib/api-errors";
import { desktopBridge } from "@/lib/desktop-bridge";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { countWorkingSessions } from "@/stores/session-status-selectors";

const DEBOUNCE_MS = 250;

export function usePowerBusySignal(): void {
  // Start in sync with the "no agents running" default so the very first
  // empty-sessions tick short-circuits before reaching the bridge.
  const lastSentRef = useRef<boolean>(false);
  const lastCountRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!desktopBridge.isElectron) return;

    function flush(busy: boolean): void {
      if (lastSentRef.current === busy) return;
      lastSentRef.current = busy;
      void desktopBridge.setBusy(busy).catch((error: unknown) => {
        const message = apiErrorMessage(error, String(error));
        console.warn(`power:set-busy failed: ${message}`);
      });
    }

    function schedule(busy: boolean): void {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        flush(busy);
      }, DEBOUNCE_MS);
    }

    // Sync at mount in case sessions are already active (e.g. after HMR).
    const initialCount = countWorkingSessions(useSessionStatusStore.getState().bySession);
    lastCountRef.current = initialCount;
    if (initialCount > 0) schedule(true);

    const unsubscribe = useSessionStatusStore.subscribe((state) => {
      const count = countWorkingSessions(state.bySession);
      // Short-circuit on the primitive count so a gate opening or a model
      // update on a busy session doesn't reschedule.
      if (count === lastCountRef.current) return;
      const wasBusy = lastCountRef.current > 0;
      const isBusy = count > 0;
      lastCountRef.current = count;
      if (wasBusy !== isBusy) schedule(isBusy);
    });

    return () => {
      unsubscribe();
      if (timerRef.current) clearTimeout(timerRef.current);
      // On unmount (renderer reload during dev), eagerly clear the blocker
      // so HMR doesn't strand a held assertion.
      if (lastSentRef.current === true) {
        void desktopBridge.setBusy(false).catch(() => {
          /* unmount cleanup — already torn down */
        });
        lastSentRef.current = false;
      }
    };
  }, []);
}

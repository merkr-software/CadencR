/**
 * Detects browser sleep/wake, network online/offline, and tab-visibility
 * changes, then uses those triggers to immediately force every registered WS
 * reconnector and run a fresh `/api/health` probe. In Electron, OS sleep/wake
 * reconnection is owned by `usePowerEvents` via the powerMonitor bridge.
 *
 * Mounted once at the app shell (`__root.tsx`). The hook owns its own
 * timers/listeners and cleans up on unmount.
 *
 * Why this matters:
 *
 * - Without this, the only path back to "connected" after browser sleep is
 *   the slow TCP-level close detection (can be 30 s+) plus exponential
 *   backoff. With it, the moment the browser surface fires `visible` /
 *   `online` we tear down stale sockets and reconnect at base delay —
 *   typically restoring the UI in well under a second.
 *
 * - The clock-jump heuristic catches Linux/Windows resumes where the
 *   `visibilitychange` event doesn't fire reliably. We tick a 1 s
 *   interval and treat any wall-clock gap > 30 s as evidence of sleep.
 */

import { useEffect } from "react";
import {
  useConnectionStatusStore,
  startHealthPolling,
  stopHealthPolling,
} from "@/stores/connection-status-store";
import { desktopBridge } from "@/lib/desktop-bridge";

/** Threshold above which a setInterval delta is interpreted as a wake. */
const CLOCK_JUMP_WAKE_MS = 30_000;
const CLOCK_TICK_MS = 1_000;
/** Cooldown between successive force-reconnects. Sleep/wake fires
 *  visibilitychange, online, and the clock-jump tick within ~ms of each
 *  other; without this they'd tear down + rebuild every socket up to 3x. */
const FORCE_COOLDOWN_MS = 1_000;

export function useConnectionWatchdog(): void {
  useEffect(() => {
    let lastForceAt = 0;
    function force(): void {
      const now = Date.now();
      if (now - lastForceAt < FORCE_COOLDOWN_MS) return;
      lastForceAt = now;
      useConnectionStatusStore.getState().forceReconnectAll();
    }

    let lastTick = Date.now();
    let clockTimer: ReturnType<typeof setInterval> | null = null;
    function startClockTicker(): void {
      if (clockTimer) return;
      lastTick = Date.now();
      clockTimer = setInterval(() => {
        const now = Date.now();
        const elapsed = now - lastTick;
        lastTick = now;
        // setInterval drift in foreground is < 50 ms; a multi-second gap
        // means the event loop was paused (laptop sleep / heavy debugger
        // pause). 30 s is a comfortable buffer above any plausible GC/JIT
        // stall and well below the TCP keep-alive timeout.
        if (elapsed > CLOCK_JUMP_WAKE_MS && !desktopBridge.isElectron) force();
      }, CLOCK_TICK_MS);
    }
    function stopClockTicker(): void {
      if (clockTimer) {
        clearInterval(clockTimer);
        clockTimer = null;
      }
    }

    function onVisibilityChange(): void {
      // Hidden tabs throttle setInterval to >= 1 s, which masquerades as
      // wake events for the clock-jump heuristic. Pause while hidden,
      // resume on visible.
      if (document.visibilityState === "visible") {
        startClockTicker();
        // In Electron, switching to another fullscreen app can emit the same
        // hidden -> visible transition as a browser tab restore. Do not tear
        // down live agent sockets for ordinary app switches; real OS sleep is
        // handled by usePowerEvents via Electron's powerMonitor bridge.
        if (!desktopBridge.isElectron) force();
      } else {
        stopClockTicker();
      }
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("online", force);
    if (document.visibilityState === "visible") startClockTicker();

    startHealthPolling();

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", force);
      stopClockTicker();
      stopHealthPolling();
    };
  }, []);
}

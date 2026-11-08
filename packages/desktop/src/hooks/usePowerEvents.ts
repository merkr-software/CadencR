/**
 * Bridge between Electron's `powerMonitor` (suspend / resume) and the
 * renderer-side WebSocket sessions + cache.
 *
 * Mounted once at the app shell next to `useConnectionWatchdog`.
 *
 * On `suspend`: flip `powerStore.suspended = true` (OS-confirmed truth)
 * and fan out `session.suspend` to every session the backend status book
 * reports busy (mid-turn or on a gate) so the backend can capture each
 * runtime's resume id before the network stalls. Conversations loaded in
 * this window get it over their socket; the rest over HTTP.
 *
 * On `resume`: clear the OS flag, force-reconnect every WS (the watchdog
 * already does this via its clock-jump heuristic; doing it here too is
 * deduped by `forceReconnectAll`'s built-in cooldown), then send
 * `session.resume` only to sessions whose lifecycle is paused-suspended
 * (i.e. we previously suspended them). Refresh `agent-catalog` only when
 * there was actually something to resume.
 *
 * Provider-neutral throughout — the hook never inspects `currentProviderId`.
 */

import { useEffect } from "react";
import { toast } from "sonner";
import { desktopBridge } from "@/lib/desktop-bridge";
import { queryClient } from "@/lib/queryClient";
import { useConnectionStatusStore } from "@/stores/connection-status-store";
import { usePowerStore } from "@/stores/power-store";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { busySessionTargets, TURN_IN_PROGRESS } from "@/stores/busy-session-targets";
import { suspendUnloadedAgents } from "@/stores/unloaded-agent-control";
import { createSessionResume } from "@/lib/ws-envelope";

const RESUME_TOAST_ID = "power:resume";
function suspendActiveSessions(): void {
  const store = useWsSessionStore.getState();
  const { loaded, unreachable } = busySessionTargets(TURN_IN_PROGRESS);
  for (const sessionId of loaded) {
    if (store.sessions[sessionId]) store.suspendForSleep(sessionId);
  }
  void suspendUnloadedAgents(unreachable);
}

/** Only sessions we earlier marked suspended need an explicit resume. */
function resumeSuspendedSessions(): number {
  const store = useWsSessionStore.getState();
  let count = 0;
  for (const [sessionId, entry] of Object.entries(store.sessions)) {
    if (!entry.serverSessionId) continue;
    if (entry.lifecycle.phase !== "paused" || entry.lifecycle.reason !== "suspended") continue;
    store.send(sessionId, createSessionResume(entry.serverSessionId));
    count += 1;
  }
  return count;
}

function handleSuspend(): void {
  usePowerStore.getState().setSuspended(true);
  suspendActiveSessions();
}

function handleResume(): void {
  // The OS flag is cleared immediately — it tracks suspend/resume, not the
  // per-session reconnect handshake. Per-session UI is driven by the
  // backend `session.lifecycle resumed` envelope through the WS handler.
  usePowerStore.getState().setSuspended(false);
  useConnectionStatusStore.getState().forceReconnectAll();
  const resumedCount = resumeSuspendedSessions();
  if (resumedCount === 0) return;
  // Catalog refresh only matters when at least one session was suspended;
  // skip the invalidation otherwise so a wake with no agents in flight
  // doesn't churn the cache.
  void queryClient.invalidateQueries({ queryKey: ["agent-catalog"] });
  toast.success(
    resumedCount === 1
      ? "Reconnecting agent after sleep…"
      : `Reconnecting ${resumedCount} agents after sleep…`,
    { id: RESUME_TOAST_ID, duration: 4_000 },
  );
}

export function usePowerEvents(): void {
  useEffect(() => {
    if (!desktopBridge.isElectron) return;
    const unsubscribeSuspend = desktopBridge.onPowerSuspend(handleSuspend);
    const unsubscribeResume = desktopBridge.onPowerResume(handleResume);
    return () => {
      unsubscribeSuspend();
      unsubscribeResume();
    };
  }, []);
}

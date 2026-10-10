import { useEffect } from "react";

import { desktopBridge } from "@/lib/desktop-bridge";
import type { BrowserAgentActivity } from "@/shared/browser-types";
import { useAutoLayoutStore } from "@/stores/auto-layout-store";

import { requestAutoReveal } from "./auto-layout-controller";

/** How long the Browser tab keeps its "agent is driving" dot after the last call. */
const ACTIVITY_LINGER_MS = 3_000;

const lingerTimers = new Map<number, ReturnType<typeof setTimeout>>();
let listenerCount = 0;
let unsubscribe: (() => void) | null = null;

export function handleAgentBrowserActivity({ scopeId, action }: BrowserAgentActivity): void {
  useAutoLayoutStore.getState().setAgentBrowserActive(scopeId, true);
  clearTimeout(lingerTimers.get(scopeId));
  lingerTimers.set(
    scopeId,
    setTimeout(() => {
      lingerTimers.delete(scopeId);
      useAutoLayoutStore.getState().setAgentBrowserActive(scopeId, false);
    }, ACTIVITY_LINGER_MS),
  );
  // Only opening a page earns a reveal; clicks, typing, and inspection act on a
  // page the agent already opened, and the user may have tucked it away since.
  if (action === "open") requestAutoReveal(scopeId, "browser", "agent");
}

/**
 * Keep one `browser:agent-activity` subscription alive while any feature
 * layout is mounted — every shell calls this, the IPC listener is shared.
 */
export function useAgentBrowserActivityListener(): void {
  useEffect((): (() => void) => {
    listenerCount += 1;
    if (listenerCount === 1) {
      unsubscribe = desktopBridge.onBrowserAgentActivity(handleAgentBrowserActivity);
    }
    return (): void => {
      listenerCount -= 1;
      if (listenerCount > 0) return;
      unsubscribe?.();
      unsubscribe = null;
    };
  }, []);
}

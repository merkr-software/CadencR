import { useEffect } from "react";

import { desktopBridge } from "@/lib/desktop-bridge";
import type { BrowserAgentAccessRequest, BrowserAgentActivity } from "@/shared/browser-types";
import { useAutoLayoutStore } from "@/stores/auto-layout-store";

import { requestAutoReveal, revealOrActivateFeatureTab } from "./auto-layout-controller";

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

export function handleAgentBrowserAccessRequest(request: BrowserAgentAccessRequest): void {
  if (request.scopeId === null) return;
  useAutoLayoutStore.getState().setAgentBrowserActive(request.scopeId, true);
  revealOrActivateFeatureTab(request.scopeId, "browser", "user-link");
}

/**
 * Keep one `browser:agent-activity` and `browser:agent-access-request`
 * subscription alive while any feature layout is mounted — every shell calls
 * this, the IPC listeners are shared.
 */
export function useAgentBrowserActivityListener(): void {
  useEffect((): (() => void) => {
    listenerCount += 1;
    if (listenerCount === 1) {
      const offActivity = desktopBridge.onBrowserAgentActivity(handleAgentBrowserActivity);
      const offAccessRequest = desktopBridge.onBrowserAgentAccessRequest(
        handleAgentBrowserAccessRequest,
      );
      unsubscribe = (): void => {
        offActivity();
        offAccessRequest();
      };
    }
    return (): void => {
      listenerCount -= 1;
      if (listenerCount > 0) return;
      unsubscribe?.();
      unsubscribe = null;
    };
  }, []);
}

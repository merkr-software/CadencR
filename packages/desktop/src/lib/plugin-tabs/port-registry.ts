import {
  PLUGIN_TAB_INSTANCE_ID_PATTERN,
  PLUGIN_TAB_PORT_MESSAGE_TYPE,
} from "@/shared/plugin-tab-host";

type PortListener = (port: MessagePort) => void;

const listeners = new Map<string, PortListener>();
/** How long a port nobody listens for is kept (a guest that loaded after its tab closed). */
const UNCLAIMED_TTL_MS = 10_000;

interface UnclaimedPort {
  port: MessagePort;
  expiry: ReturnType<typeof setTimeout>;
}

/** A port that arrived before its broker subscribed (kept until claimed or expired). */
const unclaimed = new Map<string, UnclaimedPort>();

/** Take `instanceId`'s waiting port out of `unclaimed` (still open), if any. */
function takeUnclaimed(instanceId: string): MessagePort | null {
  const entry = unclaimed.get(instanceId);
  if (!entry) return null;
  unclaimed.delete(instanceId);
  clearTimeout(entry.expiry);
  return entry.port;
}

function discardUnclaimed(instanceId: string): void {
  takeUnclaimed(instanceId)?.close();
}
let installed = false;

function handleWindowMessage(event: MessageEvent): void {
  // Only the main-window preload posts from this window; a guest or any
  // other frame cannot forge `event.source`.
  if (event.source !== window) return;
  const data: unknown = event.data;
  if (typeof data !== "object" || data === null) return;
  const { type, instanceId } = data as { type?: unknown; instanceId?: unknown };
  if (type !== PLUGIN_TAB_PORT_MESSAGE_TYPE) return;
  if (typeof instanceId !== "string" || !PLUGIN_TAB_INSTANCE_ID_PATTERN.test(instanceId)) return;
  const port = event.ports[0];
  if (!port) return;
  const listener = listeners.get(instanceId);
  if (listener) {
    listener(port);
    return;
  }
  discardUnclaimed(instanceId);
  const expiry = setTimeout(() => {
    if (unclaimed.get(instanceId)?.port === port) discardUnclaimed(instanceId);
  }, UNCLAIMED_TTL_MS);
  unclaimed.set(instanceId, { port, expiry });
}

function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("message", handleWindowMessage);
}

/**
 * Receive every port the host hands over for `instanceId` (one per guest
 * load; §5.3). One window listener serves every instance. A port that came
 * first is delivered on subscribe. Only one listener per instance; the
 * returned cleanup also closes a port still waiting for this instance.
 */
export function subscribePluginTabPorts(instanceId: string, listener: PortListener): () => void {
  install();
  listeners.set(instanceId, listener);
  const early = takeUnclaimed(instanceId);
  if (early) listener(early);
  return () => {
    if (listeners.get(instanceId) !== listener) return;
    listeners.delete(instanceId);
    discardUnclaimed(instanceId);
  };
}

import { createEnvelope } from "@/lib/ws-envelope";
import { isWindowFocused, onWindowFocusChange } from "@/lib/window-focus";

function isAppFocused(): boolean {
  return document.visibilityState === "visible" && isWindowFocused();
}

function clientId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `forge-${Date.now()}-${Math.random()}`;
}

/** The app socket's connection; it drops a send while it is not open. */
interface ForgeStatusSocket {
  send(data: string): unknown;
}

/** Subscribe the app socket and keep its focus/visibility state current. */
export function subscribeForgeStatus(ws: ForgeStatusSocket): () => void {
  const id = clientId();
  const send = (action: "subscribe.forge_status" | "forge_visibility"): void => {
    ws.send(
      JSON.stringify(
        createEnvelope("app", action, {
          client_id: id,
          visible: isAppFocused(),
        }),
      ),
    );
  };
  const report = (): void => send("forge_visibility");
  const documentCanListen = typeof document.addEventListener === "function";
  const windowCanListen = typeof window.addEventListener === "function";

  send("subscribe.forge_status");
  const offWindowFocus = onWindowFocusChange(report);
  if (documentCanListen) document.addEventListener("visibilitychange", report);
  if (windowCanListen) {
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
  }
  return () => {
    offWindowFocus();
    if (documentCanListen) document.removeEventListener("visibilitychange", report);
    if (windowCanListen) {
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
    }
  };
}

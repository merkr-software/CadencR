import { useSyncExternalStore } from "react";

function subscribeDocumentVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** Whether the window's document is shown (not minimized or on another space). */
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(
    subscribeDocumentVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );
}

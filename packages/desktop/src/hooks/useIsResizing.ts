import { useSyncExternalStore } from "react";
import { isResizing, subscribeResize } from "@/lib/resize-coordinator";

/**
 * React view of the global "is a resize-handle drag in progress?" flag from
 * `resize-coordinator`. `subscribeResize` passes the active boolean to its
 * listener; `useSyncExternalStore` ignores that argument and re-reads the
 * snapshot via `isResizing`, so the extra parameter is harmless.
 */
export function useIsResizing(): boolean {
  return useSyncExternalStore(subscribeResize, isResizing, isResizing);
}

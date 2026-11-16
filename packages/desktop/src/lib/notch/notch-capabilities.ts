import type { NotchCapabilities } from "@/shared/notch";
import { queryClient } from "@/lib/queryClient";

export const NOTCH_CAPABILITIES_QUERY_KEY = ["notch", "capabilities"] as const;

/**
 * Whether this shell can host the notch island, from the capabilities query
 * the root bridge resolves at startup. `false` until it has (and on every
 * device that isn't the macOS desktop shell — the setting is shared with them).
 */
export function notchSupportedHere(): boolean {
  return (
    queryClient.getQueryData<NotchCapabilities>(NOTCH_CAPABILITIES_QUERY_KEY)?.supported === true
  );
}

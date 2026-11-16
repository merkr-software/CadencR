import { useQuery } from "@tanstack/react-query";
import { useGetWorkspaceSetting } from "@/api/generated";
import { desktopBridge } from "@/lib/desktop-bridge";
import { NOTCH_CAPABILITIES_QUERY_KEY } from "@/lib/notch/notch-capabilities";
import { NOTIFICATION_MODE_KEY, parseNotificationMode } from "@/lib/notification-mode";

/**
 * Whether this shell can host the notch island (macOS desktop only) and
 * whether a notched display is connected. Resolved once per session: the
 * island itself follows display changes, this only gates the option.
 */
export function useNotchCapabilities() {
  return useQuery({
    queryKey: NOTCH_CAPABILITIES_QUERY_KEY,
    // Outside the desktop shell the browser fallback answers "unsupported".
    queryFn: () => desktopBridge.notchCapabilities(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** The notch is the chosen destination and this shell can host it. */
export function useNotchDestinationActive(): boolean {
  const capabilities = useNotchCapabilities();
  const modeSetting = useGetWorkspaceSetting(NOTIFICATION_MODE_KEY);
  return (
    capabilities.data?.supported === true &&
    parseNotificationMode(modeSetting.data?.value) === "notch"
  );
}

import { useIsMobile } from "@/hooks/useIsMobile";
import { useSidebarSample } from "@/lib/sidebar-sample-context";

/**
 * Whether quick replies open as the bottom sheet: on a phone. A display
 * options preview sample's popover is part of the preview, so it never uses
 * the sheet.
 */
export function useUsesGateSheet(): boolean {
  const isMobile = useIsMobile();
  return isMobile && useSidebarSample() === null;
}

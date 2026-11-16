import { useLayoutEffect, type ReactNode } from "react";
import { useSidebarSettings } from "@/hooks/useSidebarSettings";
import { useSidebarConfigStore } from "@/stores/sidebar-config-store";

/**
 * One settings subscription for the whole sidebar, not one per virtualized row:
 * the display options are mirrored into a store that rows read option by
 * option. The layout effect lands the new values before the browser paints.
 */
export function SidebarConfigProvider({ children }: { children: ReactNode }) {
  const { config } = useSidebarSettings();
  useLayoutEffect(() => {
    useSidebarConfigStore.setState({ config });
  }, [config]);
  return children;
}

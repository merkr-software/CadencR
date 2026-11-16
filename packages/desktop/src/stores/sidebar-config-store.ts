import { create } from "zustand";
import {
  DEFAULT_SIDEBAR_CONFIG,
  type SidebarConfig,
  type SidebarOptionId,
} from "@/lib/sidebar-config";

interface SidebarConfigState {
  config: SidebarConfig;
}

/**
 * The sidebar's display options, mirrored from the settings queries by
 * `SidebarConfigProvider`. Rows read one option each through
 * {@link useSidebarOption}, so changing the time format re-renders only what
 * shows a time, instead of every virtualized row subscribing to ~15 queries.
 */
export const useSidebarConfigStore = create<SidebarConfigState>(() => ({
  config: DEFAULT_SIDEBAR_CONFIG,
}));

export function useSidebarOption<K extends SidebarOptionId>(id: K): SidebarConfig[K] {
  return useSidebarConfigStore((state) => state.config[id]);
}

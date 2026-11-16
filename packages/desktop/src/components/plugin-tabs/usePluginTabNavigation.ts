import { useCallback, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";

import { CUSTOM_TABS_SECTION_ID } from "@/components/settings/custom-tabs/custom-tab-model";

export interface PluginTabNavigation {
  /** Settings → Custom tabs. */
  openSettings: () => void;
  /** Settings → Custom tabs with the create dialog open. */
  openCreate: () => void;
}

export function usePluginTabNavigation(): PluginTabNavigation {
  const navigate = useNavigate();
  const openSettings = useCallback(() => {
    void navigate({ to: "/settings", search: { section: CUSTOM_TABS_SECTION_ID } });
  }, [navigate]);
  const openCreate = useCallback(() => {
    void navigate({
      to: "/settings",
      search: { section: CUSTOM_TABS_SECTION_ID, action: "create" },
    });
  }, [navigate]);
  return useMemo(() => ({ openSettings, openCreate }), [openCreate, openSettings]);
}

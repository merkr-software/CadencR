import { useCallback, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { useSetting } from "@/hooks/useSetting";
import {
  parseSidebarViews,
  SIDEBAR_ACTIVE_VIEW_KEY,
  SIDEBAR_VIEWS_KEY,
  sidebarListMode,
  type SidebarListMode,
  type SidebarView,
} from "@/lib/sidebar-views";
import { useSidebarOption } from "@/stores/sidebar-config-store";

export interface SidebarViews {
  views: readonly SidebarView[];
  /** The view shown below the blocks in place of the lens, if any. */
  activeView: SidebarView | null;
  /** False until the saved views arrive, and while they can't be read: saving would replace them. */
  loaded: boolean;
  showView: (viewId: string | null) => void;
  saveViews: (views: readonly SidebarView[]) => void;
}

/** The saved sidebar views and the one shown, both workspace settings. */
export function useSidebarViews(): SidebarViews {
  const stored = useSetting(SIDEBAR_VIEWS_KEY);
  const active = useSetting(SIDEBAR_ACTIVE_VIEW_KEY);
  const parsed = useMemo(() => parseSidebarViews(stored.value), [stored.value]);

  useEffect(() => {
    if (parsed.error) {
      toast.error(`Could not read your saved views: ${parsed.error}.`, {
        id: "sidebar-views-error",
      });
    }
  }, [parsed.error]);

  const setStored = stored.setValue;
  const setActive = active.setValue;
  const showView = useCallback((viewId: string | null) => setActive(viewId ?? ""), [setActive]);
  const loaded = stored.isFetched && parsed.error === null;
  const saveViews = useCallback(
    (views: readonly SidebarView[]) => {
      if (!loaded) {
        toast.error("Could not save your views: the saved ones haven't been read.", {
          id: "sidebar-views-error",
        });
        return;
      }
      setStored(JSON.stringify(views));
    },
    [loaded, setStored],
  );
  const activeView = parsed.views.find((view) => view.id === active.value) ?? null;
  return useMemo(
    () => ({
      views: parsed.views,
      activeView,
      loaded,
      showView,
      saveViews,
    }),
    [activeView, loaded, parsed.views, saveViews, showView],
  );
}

/** What the sidebar lists below its blocks, per the "Group by" option and the view shown. */
export function useSidebarListMode(): SidebarListMode {
  const lens = useSidebarOption("lens");
  const { activeView } = useSidebarViews();
  return useMemo(() => sidebarListMode(lens, activeView), [activeView, lens]);
}

import { createRootRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { AppWindowControls } from "@/components/AppWindowControls";
import { GlobalOperationToasts } from "@/components/GlobalOperationToasts";
import { RootErrorBoundary } from "@/components/RootErrorBoundary";
import { RootOverlays } from "@/components/RootOverlays";
import { SidebarContext } from "@/components/SidebarContext";
import { SuspendedBanner } from "@/components/SuspendedBanner";
import { THEME_SELECTOR_SEARCH_KEY } from "@/components/theme/ThemeDrawer";
import UniversalContextMenu from "@/components/UniversalContextMenu";
import { useRootLayoutController } from "./useRootLayoutController";

interface RootSearch {
  [THEME_SELECTOR_SEARCH_KEY]?: true;
}

export const Route = createRootRoute({
  component: RootLayout,
  validateSearch: (search: Record<string, unknown>): RootSearch => {
    const raw = search[THEME_SELECTOR_SEARCH_KEY];
    return raw === true || raw === "true" ? { [THEME_SELECTOR_SEARCH_KEY]: true } : {};
  },
});

function RootLayout() {
  const controller = useRootLayoutController();
  const { features, route, sidebar } = controller;
  return (
    <SidebarContext.Provider
      value={{ collapsed: sidebar.collapsed, setCollapsed: sidebar.setCollapsed }}
    >
      <UniversalContextMenu>
        <div className="flex h-[var(--app-vh)]">
          <AppWindowControls />
          <AppShell
            isMobile={controller.isMobile}
            collapsed={sidebar.collapsed}
            setCollapsed={sidebar.setCollapsed}
            sidebarPanelRef={sidebar.sidebarPanelRef}
            leftSidebarRef={sidebar.leftSidebarRef}
            defaultLeftSize={sidebar.defaultLeftSize}
            onLayoutChanged={sidebar.handleLayoutChanged}
            onSearch={controller.openCommandPalette}
          >
            <RootErrorBoundary>
              <div
                key={route.pathname}
                className="h-full animate-in fade-in-0 duration-200 ease-out"
              >
                <Outlet />
              </div>
            </RootErrorBoundary>
          </AppShell>
          <SuspendedBanner />
          <GlobalOperationToasts />
          <RootOverlays
            commandPaletteOpen={controller.commandPaletteOpen}
            setCommandPaletteOpen={controller.setCommandPaletteOpen}
            activeProjectId={route.activeProjectId}
            activeFeatureId={route.activeFeatureId}
            confirmAction={features.confirmAction}
            setConfirmAction={features.setConfirmAction}
            onArchiveFeature={features.archiveFeature}
            onDeleteFeature={features.deleteFeature}
            appClose={features.appClose}
          />
        </div>
      </UniversalContextMenu>
    </SidebarContext.Provider>
  );
}

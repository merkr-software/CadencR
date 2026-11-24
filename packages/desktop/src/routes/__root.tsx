import { memo, useMemo } from "react";
import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { ManagedThemeRegistry } from "@/hooks/useManagedThemes";
import { NavigationHistoryTracker } from "@/hooks/useNavigationHistory";
import { AppShell } from "@/components/AppShell";
import { AppWindowControls } from "@/components/AppWindowControls";
import { CliRequestBridge } from "@/components/cli/CliRequestBridge";
import { CustomActionEditorHost } from "@/components/custom-actions/CustomActionEditorDialog";
import { RunVariablesDialogHost } from "@/components/custom-actions/RunVariablesDialog";
import { GlobalOperationToasts } from "@/components/GlobalOperationToasts";
import { NotchChannelBridge } from "@/components/notch/NotchChannelBridge";
import { RootErrorBoundary } from "@/components/RootErrorBoundary";
import { RootOverlays } from "@/components/RootOverlays";
import { SidebarContext } from "@/components/SidebarContext";
import { SuspendedBanner } from "@/components/SuspendedBanner";
import { THEME_SELECTOR_SEARCH_KEY } from "@/components/theme/ThemeDrawer";
import { ThemeSync } from "@/components/theme/ThemeSync";
import UniversalContextMenu from "@/components/UniversalContextMenu";
import {
  LastScreenTracker,
  MobileDrawerRouteCloser,
  useRootLayoutController,
} from "./useRootLayoutController";

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

/**
 * The root's prop-less hosts and bridges. Behind one memo boundary: the root
 * renders on every navigation (its content is keyed on the pathname), and none
 * of these depends on it.
 */
const RootHosts = memo(function RootHosts() {
  return (
    <>
      <SuspendedBanner />
      <GlobalOperationToasts />
      <ManagedThemeRegistry />
      <NavigationHistoryTracker />
      <LastScreenTracker />
      <NotchChannelBridge />
      <CliRequestBridge />
      <CustomActionEditorHost />
      <RunVariablesDialogHost />
      <ThemeSync />
    </>
  );
});

const RootWindowControls = memo(AppWindowControls);
const RootAppShell = memo(AppShell);

/**
 * What the routed content is keyed on. Every conversation shares one key: the
 * `ws-session` page keeps its workspaces mounted across a switch
 * (`WorkspacePool`), so a switch must re-render that page, not remount it.
 */
function routedContentKey(pathname: string): string {
  return pathname.startsWith("/ws-session/") ? "/ws-session" : pathname;
}

/**
 * The routed page. A leaf that selects its own key, so a conversation switch
 * (same key) renders nothing in the root chain above the page.
 */
const RoutedContent = memo(function RoutedContent() {
  const contentKey = useRouterState({
    select: (state) => routedContentKey(state.location.pathname),
  });
  return (
    <RootErrorBoundary>
      <div key={contentKey} className="h-full animate-in fade-in-0 duration-200 ease-out">
        <Outlet />
      </div>
    </RootErrorBoundary>
  );
});

// One element for the root's lifetime: `RootAppShell` compares its children too.
const ROUTED_CONTENT = <RoutedContent />;

function RootLayout() {
  const controller = useRootLayoutController();
  const { features, sidebar } = controller;
  const sidebarContext = useMemo(
    () => ({ collapsed: sidebar.collapsed, setCollapsed: sidebar.setCollapsed }),
    [sidebar.collapsed, sidebar.setCollapsed],
  );
  return (
    <SidebarContext.Provider value={sidebarContext}>
      <UniversalContextMenu>
        <div className="flex h-[var(--app-vh)]">
          <RootWindowControls />
          <ThemeSync />
          <RootAppShell
            isMobile={controller.isMobile}
            collapsed={sidebar.collapsed}
            setCollapsed={sidebar.setCollapsed}
            sidebarPanelRef={sidebar.sidebarPanelRef}
            leftSidebarRef={sidebar.leftSidebarRef}
            defaultLeftSize={sidebar.defaultLeftSize}
            onLayoutChanged={sidebar.handleLayoutChanged}
            onSearch={controller.openCommandPalette}
          >
            {ROUTED_CONTENT}
          </RootAppShell>
          <RootHosts />
          <MobileDrawerRouteCloser close={sidebar.closeMobileDrawer} />
          <RootOverlays
            commandPaletteOpen={controller.commandPaletteOpen}
            setCommandPaletteOpen={controller.setCommandPaletteOpen}
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

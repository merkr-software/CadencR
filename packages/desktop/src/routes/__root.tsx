import { memo, useMemo } from "react";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { ManagedThemeRegistry } from "@/hooks/useManagedThemes";
import { NavigationHistoryTracker } from "@/hooks/useNavigationHistory";
import { AppShell } from "@/components/AppShell";
import { AppWindowControls } from "@/components/AppWindowControls";
import { RoutedStage } from "@/components/app-stage/RoutedStage";
import { CliRequestBridge } from "@/components/cli/CliRequestBridge";
import { CustomActionEditorHost } from "@/components/custom-actions/CustomActionEditorDialog";
import { RunVariablesDialogHost } from "@/components/custom-actions/RunVariablesDialog";
import { GlobalOperationToasts } from "@/components/GlobalOperationToasts";
import { NotchChannelBridge } from "@/components/notch/NotchChannelBridge";
import { RootOverlays } from "@/components/RootOverlays";
import { useUiTranslation } from "@/lib/i18n/ui";
import { SidebarContext } from "@/components/SidebarContext";
import { SuspendedBanner } from "@/components/SuspendedBanner";
import { THEME_SELECTOR_SEARCH_KEY } from "@/components/theme/ThemeDrawer";
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
  notFoundComponent: NotFound,
  validateSearch: (search: Record<string, unknown>): RootSearch => {
    const raw = search[THEME_SELECTOR_SEARCH_KEY];
    return raw === true || raw === "true" ? { [THEME_SELECTOR_SEARCH_KEY]: true } : {};
  },
});

function NotFound() {
  const { t } = useUiTranslation();
  return <p>{t("shell.routes.notFound", "Not Found")}</p>;
}

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
    </>
  );
});

const RootWindowControls = memo(AppWindowControls);
const RootAppShell = memo(AppShell);

// One element for the root's lifetime: `RootAppShell` compares its children too.
const ROUTED_CONTENT = <RoutedStage outlet={<Outlet />} />;

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
          <RootAppShell
            isMobile={controller.isMobile}
            collapsed={sidebar.collapsed}
            setCollapsed={sidebar.setCollapsed}
            sidebarPanelRef={sidebar.sidebarPanelRef}
            leftSidebarRef={sidebar.leftSidebarRef}
            defaultLeftSize={sidebar.defaultLeftSize}
            onLayoutChanged={sidebar.handleLayoutChanged}
            onSidebarResize={sidebar.onSidebarResize}
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

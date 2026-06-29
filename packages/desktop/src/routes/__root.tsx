import { useCallback, useEffect, useRef, useState } from "react";
import { useGlobalShortcutById, useShortcut } from "@/hooks/useShortcut";
import { createRootRoute, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { toast } from "sonner";
import { useOperationToasts } from "@/hooks/useOperationToasts";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useVisualViewportHeight } from "@/hooks/useVisualViewportHeight";
import {
  AppShell,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "@/components/AppShell";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateFeature,
  useDeleteFeature,
  useUpdateFeatureStatus,
  type Feature,
} from "@/api/generated";
import { invalidateByUrlPrefix } from "@/lib/queryClient";
import { customInstance } from "@/api/client";
import { resolveFeatureArchiveAction } from "@/lib/feature-archive-decision";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { useShortcutsHelpStore } from "@/stores/shortcuts-help-store";
import { isTurnActive } from "@/stores/ws-turn-lifecycle";
import { useZoomHotkeys } from "@/hooks/useZoom";
import { useConnectionWatchdog } from "@/hooks/useConnectionWatchdog";
import { usePowerEvents } from "@/hooks/usePowerEvents";
import { useAutoUpdateBridge } from "@/hooks/useAutoUpdateBridge";
import { usePowerBusySignal } from "@/hooks/usePowerBusySignal";
import { useRemoteSleepGuard } from "@/hooks/useRemoteSleepGuard";
import { SuspendedBanner } from "@/components/SuspendedBanner";
import {
  initNotificationPermission,
  listenForNotificationClicks,
  listenForNotificationFailures,
  listenForNotificationFallbacks,
} from "@/lib/notify-agent-done";
import { listenForPushNavigation } from "@/lib/remote/push-register";
import { useAppClose } from "@/hooks/useAppClose";
import { useRemotePairingToast } from "@/hooks/useRemotePairingToast";
import { SidebarContext } from "@/components/SidebarContext";
import { isInCodeMirrorEditor, isInTerminalFocusZone } from "@/lib/shortcuts/dom-targets";
import { useThemeSync } from "@/hooks/useTheme";
import UniversalContextMenu from "@/components/UniversalContextMenu";
import { RootOverlays, type ConfirmFeatureAction } from "@/components/RootOverlays";
import { RootErrorBoundary } from "@/components/RootErrorBoundary";
import { isMeaningfulScreenPath, useLastScreenStore } from "@/stores/last-screen-store";
import { THEME_SELECTOR_SEARCH_KEY } from "@/components/theme/ThemeDrawer";
import {
  archiveFeatureInCachedLists,
  closeFeatureSession,
  navigateToFeatureIdOrHome,
  removeFeatureFromCachedLists,
} from "@/components/project-feature-navigation";

/**
 * Root-level search validator. The global theme drawer's open state lives in
 * the URL as `?theme-selector=true`, and TanStack Router merges parent
 * search into every child route — so validating it here means it survives
 * navigation across any route, including strict ones like
 * `/ws-session/$sessionId` whose own validator would otherwise drop it.
 */
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
  useOperationToasts();
  useRemotePairingToast();
  useThemeSync();
  useConnectionWatchdog();
  usePowerEvents();
  usePowerBusySignal();
  useRemoteSleepGuard();
  useAutoUpdateBridge();
  const leftWidth = useDebouncedSetting("sidebar_left_width", 300, { immediateCache: false });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  // On mobile, keep the shell sized above the on-screen keyboard so the
  // terminal prompt (and any bottom-pinned input) stays visible while typing.
  useVisualViewportHeight(isMobile);
  const leftSidebarRef = useRef<HTMLDivElement>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const sidebarCollapsed = useDebouncedSetting("sidebar_collapsed", 0);
  // On mobile the sidebar is an off-canvas drawer (closed by default). Its
  // open/closed state is ephemeral and must not clobber the persisted desktop
  // collapse preference, so it lives in local state there.
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const isSidebarCollapsed = isMobile ? !mobileDrawerOpen : sidebarCollapsed.value === "true";
  const setSidebarCollapsed = useCallback(
    (collapsed: boolean) => {
      if (isMobile) setMobileDrawerOpen(!collapsed);
      else sidebarCollapsed.setValue(collapsed ? "true" : "false");
    },
    [isMobile, sidebarCollapsed],
  );
  const sidebarPanelRef = useRef<PanelImperativeHandle>(null);

  useEffect(() => {
    if (isMobile || sidebarCollapsed.isLoading) return;
    const panel = sidebarPanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed() === isSidebarCollapsed) return;
    if (isSidebarCollapsed) panel.collapse();
    else panel.expand();
  }, [isMobile, sidebarCollapsed.isLoading, isSidebarCollapsed]);

  useEffect(() => {
    leftSidebarRef.current?.focus();
  }, []);
  useEffect(() => {
    useSessionStatusStore.getState().connect();
    return () => useSessionStatusStore.getState().disconnect();
  }, []);
  useEffect(() => {
    void initNotificationPermission();
  }, []);
  useEffect(() => listenForNotificationClicks(navigate, queryClient), [navigate, queryClient]);
  useEffect(() => listenForNotificationFallbacks(navigate, queryClient), [navigate, queryClient]);
  useEffect(() => listenForNotificationFailures(), []);
  // Web Push (PWA/remote): route notification clicks to the right session. No-op
  // in the desktop shell and when push is unsupported.
  useEffect(() => listenForPushNavigation(navigate, queryClient), [navigate, queryClient]);
  const routerState = useRouterState();
  const routeParams = (routerState.location.pathname.match(
    /\/projects\/(\d+)(?:\/features\/(\d+))?/,
  ) ?? []) as string[];
  const activeProjectId = routeParams[1]
    ? Number(routeParams[1])
    : routerState.location.search?.projectId
      ? Number(routerState.location.search.projectId)
      : null;

  const activeFeatureId = routeParams[2]
    ? Number(routeParams[2])
    : routerState.location.search?.featureId
      ? Number(routerState.location.search.featureId)
      : null;

  // Record the last "meaningful" screen so the settings → theme drawer flow
  // can send the user back to where they were working. We deliberately skip
  // settings/home so the **Change theme** button never bounces back to itself.
  // The full `search` object is captured because routes like
  // `/ws-session/$sessionId` throw without `cwd` / `featureId` / `projectId`.
  const pathname = routerState.location.pathname;
  const search = routerState.location.search as Record<string, unknown> | undefined;
  useEffect(() => {
    if (isMeaningfulScreenPath(pathname)) {
      useLastScreenStore.getState().setLastScreen({
        pathname,
        search: search ?? {},
      });
    }
  }, [pathname, search]);

  // Tapping a nav item navigates; auto-close the mobile drawer so the user
  // lands on the destination instead of staring at the overlay.
  useEffect(() => {
    setMobileDrawerOpen(false);
  }, [pathname]);

  const invalidateFeatures = useCallback(() => {
    // Catch every feature-scoped cache: list, detail, plan, plan/progress, etc.
    void invalidateByUrlPrefix(queryClient, "/api/features");
  }, [queryClient]);

  const createSessionMutation = useCreateFeature({
    mutation: {
      onSuccess: (session) => {
        invalidateFeatures();
        if (activeProjectId == null) return;
        // Routes through the legacy feature route, which immediately redirects
        // to the ws-session route once `useListProjects()` resolves the cwd.
        void navigate({
          to: "/projects/$projectId/features/$featureId",
          params: {
            projectId: String(activeProjectId),
            featureId: String(session.id),
          },
        });
      },
    },
  });

  const [confirmAction, setConfirmAction] = useState<ConfirmFeatureAction | null>(null);
  // Track which feature to navigate to after deletion
  const deleteNavTargetRef = useRef<number | null>(null);
  const deleteFeatureMutation = useDeleteFeature({
    mutation: {
      onError: () => {
        toast.error("Failed to delete feature");
      },
      onSuccess: (_data, variables) => {
        removeFeatureFromCachedLists(queryClient, variables.id);
        closeFeatureSession(variables.id);
        invalidateFeatures();
        if (activeProjectId == null) return;
        const targetId = deleteNavTargetRef.current;
        deleteNavTargetRef.current = null;
        navigateToFeatureIdOrHome(navigate, activeProjectId, targetId);
      },
    },
  });

  const archiveFeatureMutation = useUpdateFeatureStatus({
    mutation: {
      onError: () => {
        toast.error("Failed to archive session");
      },
      onSuccess: (_data, variables) => {
        archiveFeatureInCachedLists(queryClient, variables.id);
        closeFeatureSession(variables.id);
        invalidateFeatures();
        if (activeProjectId == null) return;
        const targetId = deleteNavTargetRef.current;
        deleteNavTargetRef.current = null;
        navigateToFeatureIdOrHome(navigate, activeProjectId, targetId);
      },
    },
  });
  const handleArchiveFeature = useCallback(
    (featureId: number): void => {
      archiveFeatureMutation.mutate({
        id: featureId,
        data: { status: "archived" },
      });
    },
    [archiveFeatureMutation],
  );

  const handleDeleteFeature = useCallback(
    (featureId: number): void => {
      deleteFeatureMutation.mutate({ id: featureId });
    },
    [deleteFeatureMutation],
  );

  useZoomHotkeys();

  const appClose = useAppClose(queryClient, activeFeatureId);

  useShortcut("toggle-sidebar", (e) => {
    e.preventDefault();
    setSidebarCollapsed(!isSidebarCollapsed);
  });

  useShortcut("open-settings", (e) => {
    e.preventDefault();
    void navigate({ to: "/settings" });
  });

  useGlobalShortcutById("shortcuts-help", (e) => {
    e.preventDefault();
    useShortcutsHelpStore.getState().toggle();
  });

  // Stop all running agents across the app.
  useShortcut("stop-all-agents", (e) => {
    const store = useWsSessionStore.getState();
    const sessions = store.sessions;
    let stopped = false;
    for (const sessionId of Object.keys(sessions)) {
      if (isTurnActive(sessions[sessionId].lifecycle)) {
        store.interrupt(sessionId);
        stopped = true;
      }
    }
    if (stopped) e.preventDefault();
  });

  useShortcut("command-palette", (e) => {
    // ⌘K is also "Delete line" inside the CodeMirror buffer; let the editor
    // keymap win when focus is in the editor (see `editor-buffer-keymap.ts`).
    // It should also stay out of terminals, where the shell/xterm should own
    // command-editing chords while terminal focus is active.
    if (isInCodeMirrorEditor(e.target) || isInTerminalFocusZone(e.target)) return;
    e.preventDefault();
    setCommandPaletteOpen((prev) => !prev);
  });
  const openCommandPalette = useCallback(() => setCommandPaletteOpen(true), []);

  // Scoped to a feature page: disabled when no project is active (e.g. the
  // /agents grid), so the Unified Agents view owns ⌘⇧N with its own
  // project-picker flow instead of this binding silently no-opping.
  useShortcut(
    "new-session",
    (e) => {
      e.preventDefault();
      if (activeProjectId == null) return;
      createSessionMutation.mutate({ data: { project_id: activeProjectId, type: "ws-session" } });
    },
    { enabled: activeProjectId != null },
  );

  // Archive active features, delete archived features.
  useShortcut("delete-feature", async (e) => {
    e.preventDefault();
    if (activeProjectId == null || activeFeatureId == null) return;
    try {
      const features = await customInstance<Feature[]>({
        method: "GET",
        url: `/api/features?project_id=${activeProjectId}&include_archived=true`,
      });
      const feature = features.find((f) => f.id === activeFeatureId);
      if (!feature) return;
      const activeFeatures = features.filter((f) => f.status === "active");
      const idx = activeFeatures.findIndex((f) => f.id === activeFeatureId);
      const remaining = activeFeatures.filter((f) => f.id !== activeFeatureId);
      const target = idx > 0 ? activeFeatures[idx - 1] : (remaining[0] ?? null);
      deleteNavTargetRef.current = target?.id ?? null;
      const action = await resolveFeatureArchiveAction(feature);
      setConfirmAction({
        action,
        feature,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load features");
    }
  });

  const handleLayoutChanged = useCallback(() => {
    const size = sidebarPanelRef.current?.getSize();
    if (!size || size.inPixels < 50) return;
    leftWidth.setValue(String(Math.round(size.inPixels)));
  }, [leftWidth]);

  // Clamp the persisted width into the current resize bounds so a value saved
  // under an older, smaller minimum doesn't reopen the sidebar too narrow.
  const savedWidth = leftWidth.value ? Number(leftWidth.value) : null;
  const clampedWidth =
    savedWidth != null && Number.isFinite(savedWidth)
      ? Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, savedWidth))
      : SIDEBAR_DEFAULT_WIDTH;
  const defaultLeftSize = `${clampedWidth}px`;

  return (
    <SidebarContext.Provider
      value={{ collapsed: isSidebarCollapsed, setCollapsed: setSidebarCollapsed }}
    >
      <UniversalContextMenu>
        <div className="flex h-[var(--app-vh)]">
          <AppShell
            isMobile={isMobile}
            collapsed={isSidebarCollapsed}
            setCollapsed={setSidebarCollapsed}
            sidebarPanelRef={sidebarPanelRef}
            leftSidebarRef={leftSidebarRef}
            defaultLeftSize={defaultLeftSize}
            onLayoutChanged={handleLayoutChanged}
            onSearch={openCommandPalette}
          >
            <RootErrorBoundary>
              <div
                key={routerState.location.pathname}
                className="h-full animate-in fade-in-0 duration-200 ease-out"
              >
                <Outlet />
              </div>
            </RootErrorBoundary>
          </AppShell>
          <SuspendedBanner />
          <RootOverlays
            commandPaletteOpen={commandPaletteOpen}
            setCommandPaletteOpen={setCommandPaletteOpen}
            activeProjectId={activeProjectId}
            activeFeatureId={activeFeatureId}
            confirmAction={confirmAction}
            setConfirmAction={setConfirmAction}
            onArchiveFeature={handleArchiveFeature}
            onDeleteFeature={handleDeleteFeature}
            appClose={appClose}
          />
        </div>
      </UniversalContextMenu>
    </SidebarContext.Provider>
  );
}

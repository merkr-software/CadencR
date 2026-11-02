import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { toast } from "sonner";
import { useCreateFeature, useDeleteFeature, type Feature } from "@/api/generated";
import { customInstance } from "@/api/client";
import type { ConfirmFeatureAction } from "@/components/RootOverlays";
import {
  closeFeatureSession,
  navigateToFeatureIdOrHome,
  removeFeatureFromCachedLists,
} from "@/components/project-feature-navigation";
import { useAppClose } from "@/hooks/useAppClose";
import { useArchiveFeatureAction } from "@/hooks/useArchiveFeatureAction";
import { useAutoUpdateBridge } from "@/hooks/useAutoUpdateBridge";
import { useConnectionWatchdog } from "@/hooks/useConnectionWatchdog";
import { useIsMobile } from "@/hooks/useIsMobile";
import { usePowerBusySignal } from "@/hooks/usePowerBusySignal";
import { usePowerEvents } from "@/hooks/usePowerEvents";
import { useRemotePairingToast } from "@/hooks/useRemotePairingToast";
import { useRemoteSleepGuard } from "@/hooks/useRemoteSleepGuard";
import { useGlobalShortcutById, useShortcut } from "@/hooks/useShortcut";
import { useThemeSync } from "@/hooks/useTheme";
import { useRouteFeatureIds } from "@/hooks/useRouteFeatureIds";
import { useVisualViewportHeight } from "@/hooks/useVisualViewportHeight";
import { useZoomHotkeys } from "@/hooks/useZoom";
import { resolveFeatureArchiveAction } from "@/lib/feature-archive-decision";
import {
  initNotificationPermission,
  listenForNotificationClicks,
  listenForNotificationFailures,
  listenForNotificationFallbacks,
} from "@/lib/notify-agent-done";
import { forgetFeatureProject } from "@/lib/plugin-tabs/feature-projects";
import { invalidateByUrlPrefix } from "@/lib/queryClient";
import { listenForPushNavigation } from "@/lib/remote/push-register";
import { isInCodeMirrorEditor, isInTerminalFocusZone } from "@/lib/shortcuts/dom-targets";
import { toastError } from "@/lib/api-errors";
import { isTurnActive } from "@/stores/ws-turn-lifecycle";
import { isMeaningfulScreenPath, useLastScreenStore } from "@/stores/last-screen-store";
import { useSessionStatusStore } from "@/stores/session-status-store";
import { useShortcutsHelpStore } from "@/stores/shortcuts-help-store";
import { useWsSessionStore } from "@/stores/ws-session-store";
import { type SidebarController, useSidebarController } from "./useSidebarController";

function useRootEnvironment(isMobile: boolean) {
  useRemotePairingToast();
  useThemeSync();
  useConnectionWatchdog();
  usePowerEvents();
  usePowerBusySignal();
  useRemoteSleepGuard();
  useAutoUpdateBridge();
  useZoomHotkeys();
  useVisualViewportHeight(isMobile);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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
  useEffect(() => listenForPushNavigation(navigate, queryClient), [navigate, queryClient]);
}

function useRootRoute(closeMobileDrawer: () => void) {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;
  const search = routerState.location.search as Record<string, unknown> | undefined;
  const { projectId: activeProjectId, featureId: activeFeatureId } = useRouteFeatureIds();
  useEffect(() => {
    if (!isMeaningfulScreenPath(pathname)) return;
    useLastScreenStore.getState().setLastScreen({ pathname, search: search ?? {} });
  }, [pathname, search]);
  useEffect(() => {
    closeMobileDrawer();
  }, [closeMobileDrawer, pathname]);
  return useMemo(
    () => ({ activeFeatureId, activeProjectId, pathname, routerState }),
    [activeFeatureId, activeProjectId, pathname, routerState],
  );
}

type RootRouteState = ReturnType<typeof useRootRoute>;

function useRootFeatureActions(route: RootRouteState) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmAction, setConfirmAction] = useState<ConfirmFeatureAction | null>(null);
  const [archiveActiveFeatures, setArchiveActiveFeatures] = useState<Feature[]>([]);
  const deleteNavTargetRef = useRef<number | null>(null);
  const invalidateFeatures = useCallback(
    () => void invalidateByUrlPrefix(queryClient, "/api/features"),
    [queryClient],
  );
  const createSessionMutation = useCreateFeature({
    mutation: {
      onSuccess: (session) => {
        invalidateFeatures();
        if (route.activeProjectId == null) return;
        void navigate({
          to: "/projects/$projectId/features/$featureId",
          params: {
            projectId: String(route.activeProjectId),
            featureId: String(session.id),
          },
        });
      },
    },
  });
  const deleteMutation = useDeleteFeature({
    mutation: {
      onError: () => toast.error("Failed to delete feature"),
      onSuccess: (_data, variables) => {
        removeFeatureFromCachedLists(queryClient, variables.id);
        closeFeatureSession(variables.id);
        forgetFeatureProject(variables.id);
        invalidateFeatures();
        if (route.activeProjectId == null) return;
        const targetId = deleteNavTargetRef.current;
        deleteNavTargetRef.current = null;
        navigateToFeatureIdOrHome(navigate, route.activeProjectId, targetId);
      },
    },
  });
  const archiveFeature = useArchiveFeatureAction({
    activeFeatureId: route.activeFeatureId,
    activeFeatures: archiveActiveFeatures,
    projectId: route.activeProjectId,
  });
  const deleteFeature = useCallback(
    (featureId: number): void => deleteMutation.mutate({ id: featureId }),
    [deleteMutation],
  );
  const appClose = useAppClose(queryClient, route.activeFeatureId);
  return {
    appClose,
    archiveFeature,
    confirmAction,
    createSessionMutation,
    deleteFeature,
    deleteNavTargetRef,
    setConfirmAction,
    setArchiveActiveFeatures,
  };
}

type RootFeatureActions = ReturnType<typeof useRootFeatureActions>;

async function prepareFeatureAction(
  projectId: number,
  featureId: number,
): Promise<{
  activeFeatures: Feature[];
  confirmAction: ConfirmFeatureAction;
  targetId: number | null;
} | null> {
  const features = await customInstance<Feature[]>({
    method: "GET",
    url: `/api/features?project_id=${projectId}&include_archived=true`,
  });
  const feature = features.find((candidate) => candidate.id === featureId);
  if (!feature) return null;
  const activeFeatures = features.filter((candidate) => candidate.status === "active");
  const index = activeFeatures.findIndex((candidate) => candidate.id === featureId);
  const remaining = activeFeatures.filter((candidate) => candidate.id !== featureId);
  const target = index > 0 ? activeFeatures[index - 1] : (remaining[0] ?? null);
  return {
    activeFeatures,
    confirmAction: { action: await resolveFeatureArchiveAction(feature), feature },
    targetId: target?.id ?? null,
  };
}

function useRootShortcuts(
  route: RootRouteState,
  sidebar: SidebarController,
  features: RootFeatureActions,
  setCommandPaletteOpen: React.Dispatch<React.SetStateAction<boolean>>,
) {
  const navigate = useNavigate();
  useShortcut("toggle-sidebar", (event) => {
    event.preventDefault();
    sidebar.setCollapsed(!sidebar.collapsed);
  });
  useShortcut("open-settings", (event) => {
    event.preventDefault();
    void navigate({ to: "/settings" });
  });
  useGlobalShortcutById("shortcuts-help", (event) => {
    event.preventDefault();
    useShortcutsHelpStore.getState().toggle();
  });
  useShortcut("stop-all-agents", (event) => {
    const store = useWsSessionStore.getState();
    let stopped = false;
    for (const [sessionId, session] of Object.entries(store.sessions)) {
      if (!isTurnActive(session.lifecycle)) continue;
      store.interrupt(sessionId);
      stopped = true;
    }
    if (stopped) event.preventDefault();
  });
  useShortcut("command-palette", (event) => {
    if (isInCodeMirrorEditor(event.target) || isInTerminalFocusZone(event.target)) return;
    event.preventDefault();
    setCommandPaletteOpen((open) => !open);
  });
  useShortcut(
    "new-session",
    (event) => {
      event.preventDefault();
      if (route.activeProjectId == null) return;
      features.createSessionMutation.mutate({
        data: { project_id: route.activeProjectId, type: "ws-session" },
      });
    },
    { enabled: route.activeProjectId != null },
  );
  useShortcut("delete-feature", async (event) => {
    event.preventDefault();
    if (route.activeProjectId == null || route.activeFeatureId == null) return;
    const toastId = `feature-archive-check-${route.activeFeatureId}`;
    toast.loading("Checking conversation…", { id: toastId });
    try {
      const prepared = await prepareFeatureAction(route.activeProjectId, route.activeFeatureId);
      if (!prepared) return;
      features.deleteNavTargetRef.current = prepared.targetId;
      features.setArchiveActiveFeatures(prepared.activeFeatures);
      features.setConfirmAction(prepared.confirmAction);
    } catch (error) {
      toastError(error, "Failed to load features");
    } finally {
      toast.dismiss(toastId);
    }
  });
}

export function useRootLayoutController() {
  const isMobile = useIsMobile();
  useRootEnvironment(isMobile);
  const sidebar = useSidebarController(isMobile);
  const route = useRootRoute(sidebar.closeMobileDrawer);
  const features = useRootFeatureActions(route);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  useRootShortcuts(route, sidebar, features, setCommandPaletteOpen);
  const openCommandPalette = useCallback(() => setCommandPaletteOpen(true), []);
  return {
    commandPaletteOpen,
    features,
    isMobile,
    openCommandPalette,
    route,
    setCommandPaletteOpen,
    sidebar,
  };
}

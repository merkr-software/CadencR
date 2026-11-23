import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  getListFeaturesQueryOptions,
  useCreateFeature,
  useDeleteFeature,
  type Feature,
} from "@/api/generated";
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
import { useAppZoom } from "@/hooks/useZoom";
import { navigateToConversation } from "@/lib/conversation-route";
import { resolveFeatureArchiveAction } from "@/lib/feature-archive-decision";
import {
  initNotificationPermission,
  listenForNotificationClicks,
  listenForNotificationFailures,
  listenForNotificationFallbacks,
} from "@/lib/notify-agent-done";
import { forgetFeatureProject } from "@/lib/plugin-tabs/feature-projects";
import { invalidateFeatureLists } from "@/lib/featureUpdated";
import { listenForPushNavigation } from "@/lib/remote/push-register";
import { isInCodeMirrorEditor, isInTerminalFocusZone } from "@/lib/shortcuts/dom-targets";
import { toastError } from "@/lib/api-errors";
import { busySessionTargets, MID_TURN } from "@/stores/busy-session-targets";
import { stopUnloadedAgents } from "@/stores/unloaded-agent-control";
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
  useAppZoom();
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

/**
 * Navigating closes the mobile drawer. A leaf of its own: it follows the
 * pathname, which the root layout itself never needs to render for.
 */
export const MobileDrawerRouteCloser = memo(function MobileDrawerRouteCloser({
  close,
}: {
  close: () => void;
}): null {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  useEffect(() => {
    close();
  }, [close, pathname]);
  return null;
});

/**
 * Remembers the last meaningful screen. A leaf of its own: it reads the search
 * params too, which change on every tab focus, and must not re-render the root.
 */
export function LastScreenTracker(): null {
  const { pathname, search } = useRouterState({ select: (state) => state.location });
  useEffect(() => {
    if (!isMeaningfulScreenPath(pathname)) return;
    useLastScreenStore
      .getState()
      .setLastScreen({ pathname, search: (search as Record<string, unknown> | undefined) ?? {} });
  }, [pathname, search]);
  return null;
}

interface RootRouteIds {
  activeProjectId: number | null;
  activeFeatureId: number | null;
}

function useRootFeatureActions(route: RootRouteIds) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmAction, setConfirmAction] = useState<ConfirmFeatureAction | null>(null);
  const [archiveActiveFeatures, setArchiveActiveFeatures] = useState<Feature[]>([]);
  const deleteNavTargetRef = useRef<number | null>(null);
  const createSessionPendingRef = useRef(false);
  const createSessionMutation = useCreateFeature({
    mutation: {
      onSuccess: (session, variables) => {
        void invalidateFeatureLists(queryClient, variables.data.project_id);
        if (route.activeProjectId == null) return;
        navigateToConversation(navigate, route.activeProjectId, session.id, {
          featureKnown: true,
        });
      },
      onError: (error) => toastError(error, "Failed to create conversation"),
      onSettled: () => {
        createSessionPendingRef.current = false;
      },
    },
  });
  const { mutate: deleteFeatureMutate } = useDeleteFeature({
    mutation: {
      onError: () => toast.error("Failed to delete feature"),
      onSuccess: (_data, variables) => {
        removeFeatureFromCachedLists(queryClient, variables.id);
        closeFeatureSession(variables.id);
        forgetFeatureProject(variables.id);
        void invalidateFeatureLists(queryClient, route.activeProjectId);
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
    (featureId: number): void => deleteFeatureMutate({ id: featureId }),
    [deleteFeatureMutate],
  );
  const appClose = useAppClose(queryClient, route.activeFeatureId);
  const { mutate: createSessionMutate } = createSessionMutation;
  const createSession = useCallback(
    (projectId: number): void => {
      if (createSessionPendingRef.current) return;
      createSessionPendingRef.current = true;
      createSessionMutate({ data: { project_id: projectId, type: "ws-session" } });
    },
    [createSessionMutate],
  );
  // Stable across navigations: RootOverlays is memoized on these.
  return useMemo(
    () => ({
      appClose,
      archiveFeature,
      confirmAction,
      createSession,
      deleteFeature,
      deleteNavTargetRef,
      setConfirmAction,
      setArchiveActiveFeatures,
    }),
    [appClose, archiveFeature, confirmAction, createSession, deleteFeature],
  );
}

type RootFeatureActions = ReturnType<typeof useRootFeatureActions>;

async function prepareFeatureAction(
  queryClient: QueryClient,
  projectId: number,
  featureId: number,
): Promise<{
  activeFeatures: Feature[];
  confirmAction: ConfirmFeatureAction;
  targetId: number | null;
} | null> {
  const listOptions = getListFeaturesQueryOptions({
    project_id: projectId,
    include_archived: true,
  });
  const features = await queryClient.ensureQueryData({ ...listOptions, retry: false });
  const feature = features.find((candidate) => candidate.id === featureId);
  if (!feature) return null;
  const activeFeatures = features.filter((candidate) => candidate.status === "active");
  const index = activeFeatures.findIndex((candidate) => candidate.id === featureId);
  const remaining = activeFeatures.filter((candidate) => candidate.id !== featureId);
  const target = index > 0 ? activeFeatures[index - 1] : (remaining[0] ?? null);
  return {
    activeFeatures,
    confirmAction: { action: await resolveFeatureArchiveAction(feature, queryClient), feature },
    targetId: target?.id ?? null,
  };
}

function useRootShortcuts(
  route: RootRouteIds,
  sidebar: SidebarController,
  features: RootFeatureActions,
  setCommandPaletteOpen: React.Dispatch<React.SetStateAction<boolean>>,
) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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
    const { loaded, unreachable } = busySessionTargets(MID_TURN);
    if (loaded.length === 0 && unreachable.length === 0) return;
    event.preventDefault();
    const store = useWsSessionStore.getState();
    for (const sessionId of loaded) store.interrupt(sessionId);
    void stopUnloadedAgents(unreachable);
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
      if (event.repeat || route.activeProjectId == null) return;
      features.createSession(route.activeProjectId);
    },
    { enabled: route.activeProjectId != null },
  );
  useShortcut("delete-feature", async (event) => {
    event.preventDefault();
    if (route.activeProjectId == null || route.activeFeatureId == null) return;
    const toastId = `feature-archive-check-${route.activeFeatureId}`;
    toast.loading("Checking conversation…", { id: toastId });
    try {
      const prepared = await prepareFeatureAction(
        queryClient,
        route.activeProjectId,
        route.activeFeatureId,
      );
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
  // Ids, not the location: the root renders once per conversation switch for
  // these, and its memoized children (shell, hosts, routed page) bail out.
  const { projectId: activeProjectId, featureId: activeFeatureId } = useRouteFeatureIds();
  const routeIds = useMemo(
    () => ({ activeProjectId, activeFeatureId }),
    [activeFeatureId, activeProjectId],
  );
  const features = useRootFeatureActions(routeIds);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  useRootShortcuts(routeIds, sidebar, features, setCommandPaletteOpen);
  const openCommandPalette = useCallback(() => setCommandPaletteOpen(true), []);
  return useMemo(
    () => ({
      commandPaletteOpen,
      features,
      isMobile,
      openCommandPalette,
      setCommandPaletteOpen,
      sidebar,
    }),
    [commandPaletteOpen, features, isMobile, openCommandPalette, sidebar],
  );
}

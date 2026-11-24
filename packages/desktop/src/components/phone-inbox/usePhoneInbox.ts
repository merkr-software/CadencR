import { useCallback, useMemo } from "react";
import { useListProjects, type Feature, type Project } from "@/api/generated";
import { useSidebarAttention } from "@/components/SidebarAttentionProvider";
import { useRecentFeatures } from "@/components/SidebarRecentSection";
import { useFrozenActionOrder } from "@/hooks/useFrozenActionOrder";
import { apiErrorMessage } from "@/lib/api-errors";
import { newestFirstWithinTier, type ResolvedNextAction } from "@/lib/next-actions";
import { usePendingGatePopoverStore } from "@/stores/pending-gate-popover-store";
import { isLiveStatusKnown } from "@/stores/session-status-selectors";
import { useSessionStatusStore } from "@/stores/session-status-store";

/** One section's rows and whether more may still arrive. */
export interface InboxSection<T> {
  rows: readonly T[];
  /** True while rows may still arrive: a skeleton holds the place of an empty list. */
  loading: boolean;
  error: string | null;
}

export interface PhoneInboxData {
  forMe: InboxSection<ResolvedNextAction>;
  working: InboxSection<Feature>;
  recent: InboxSection<Feature>;
  projects: InboxSection<Project>;
  projectsById: ReadonlyMap<number, Project>;
  /** Fetches the projects again after an error. */
  retryProjects: () => void;
  /** That fetch is under way. */
  projectsRetrying: boolean;
}

const NO_FEATURES: readonly Feature[] = [];
const NO_PROJECTS: readonly Project[] = [];

/**
 * What the phone inbox lists, from the sidebar's sources: For me (the attention
 * index's action list: the waiting requests in the quick reply's order, each
 * other kind newest first), In progress (agents at work)
 * and Recent (the shared recent list, less what the sections above already
 * show). Reads the attention context, which changes only when the set of
 * waiting, working, failed or unread conversations does: a streaming agent
 * re-renders nothing here.
 */
export function usePhoneInbox(): PhoneInboxData {
  const { items, actions, actionsLoading, loadingStates } = useSidebarAttention();
  // Before the first status snapshot, "nothing waiting" would be a guess.
  const statusKnown = useSessionStatusStore(isLiveStatusKnown);
  // Rows hold their place while the user works a quick reply from here.
  const gateInUse = usePendingGatePopoverStore((state) => state.open?.origin === "user");
  const ordered = useMemo(() => newestFirstWithinTier(actions), [actions]);
  const forMeRows = useFrozenActionOrder(ordered, gateInUse);
  const workingRows = useMemo(
    () => items.filter((item) => item.state === "working").map((item) => item.feature),
    [items],
  );
  const recentQuery = useRecentFeatures(true);
  const recentRows = useMemo(() => {
    const shown = new Set([
      ...forMeRows.map((action) => action.feature.id),
      ...workingRows.map((feature) => feature.id),
    ]);
    return (recentQuery.data ?? NO_FEATURES).filter((feature) => !shown.has(feature.id));
  }, [forMeRows, recentQuery.data, workingRows]);
  const projectsQuery = useListProjects();
  const projects = projectsQuery.data ?? NO_PROJECTS;
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );

  const forMe = useMemo<InboxSection<ResolvedNextAction>>(
    () => ({ rows: forMeRows, loading: !statusKnown || actionsLoading, error: null }),
    [actionsLoading, forMeRows, statusKnown],
  );
  const workingLoading = !statusKnown || loadingStates.includes("working");
  const working = useMemo<InboxSection<Feature>>(
    () => ({ rows: workingRows, loading: workingLoading, error: null }),
    [workingLoading, workingRows],
  );
  const recentError = recentQuery.error
    ? apiErrorMessage(recentQuery.error, "Could not load recent conversations")
    : null;
  const recent = useMemo<InboxSection<Feature>>(
    () => ({ rows: recentRows, loading: recentQuery.isPending, error: recentError }),
    [recentError, recentQuery.isPending, recentRows],
  );
  const projectsError = projectsQuery.error
    ? apiErrorMessage(projectsQuery.error, "Could not load projects")
    : null;
  const projectSection = useMemo<InboxSection<Project>>(
    () => ({ rows: projects, loading: projectsQuery.isPending, error: projectsError }),
    [projects, projectsError, projectsQuery.isPending],
  );
  const { refetch } = projectsQuery;
  const retryProjects = useCallback(() => void refetch(), [refetch]);
  const projectsRetrying = projectsError !== null && projectsQuery.isFetching;
  return useMemo(
    () => ({
      forMe,
      working,
      recent,
      projects: projectSection,
      projectsById,
      retryProjects,
      projectsRetrying,
    }),
    [forMe, projectSection, projectsById, projectsRetrying, recent, retryProjects, working],
  );
}

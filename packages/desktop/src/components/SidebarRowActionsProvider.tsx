import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  useListFeatures,
  useListFeatureWorktrees,
  type Feature,
  type FeatureWorktreeInfo,
} from "@/api/generated";
import { FeatureArchiveDialogs } from "@/components/FeatureArchiveDialogs";
import { useFeatureArchiveConfirmation } from "@/components/useFeatureArchiveConfirmation";
import { useArchiveFeatureAction } from "@/hooks/useArchiveFeatureAction";
import {
  useCloseFeatureActivity,
  type CloseFeatureActivityArgs,
} from "@/hooks/useCloseFeatureActivity";
import { useFeatureRowMutations, type FeatureRowMutations } from "@/hooks/useFeatureRowMutations";
import { useRouteFeatureIds } from "@/hooks/useRouteFeatureIds";
import { FEATURE_WORKTREES_STALE_MS } from "@/lib/sidebar-queries";

/** What a conversation row outside its project can do from its context menu. */
export interface SidebarRowActions extends Pick<FeatureRowMutations, "togglePin" | "unarchive"> {
  /** Opens the archive dialog of an active conversation, the delete one of an archived one. */
  archiveOrDelete: (feature: Feature) => void;
  closeActivity: (args: CloseFeatureActivityArgs) => void;
}

const SidebarRowActionsContext = createContext<SidebarRowActions | null>(null);

/** Null outside the sidebar: such rows offer no context menu. */
export function useSidebarRowActions(): SidebarRowActions | null {
  return useContext(SidebarRowActionsContext);
}

const NO_FEATURES: Feature[] = [];
const NO_WORKTREES: FeatureWorktreeInfo[] = [];

/**
 * The actions of the rows above the project list and of the cross-project
 * lists (Pinned, For me, In progress, Recent, lenses, views), with the one
 * archive dialog they share. A project's own rows keep theirs in its section.
 */
export function SidebarRowActionsProvider({ children }: { children: ReactNode }): ReactElement {
  const [confirmFeature, setConfirmFeature] = useState<Feature | null>(null);
  const { confirmation, archiveFeature, mutations } = useCrossProjectFeatureActions(confirmFeature);
  const closeActivity = useCloseFeatureActivity();
  const { togglePin, unarchive } = mutations;
  const actions = useMemo<SidebarRowActions>(
    () => ({ togglePin, archiveOrDelete: setConfirmFeature, unarchive, closeActivity }),
    [closeActivity, togglePin, unarchive],
  );
  return (
    <SidebarRowActionsContext.Provider value={actions}>
      {children}
      <FeatureArchiveDialogs
        projectId={confirmFeature?.project_id ?? 0}
        confirmFeatureId={confirmFeature?.id ?? null}
        confirmation={confirmation}
        onClose={() => setConfirmFeature(null)}
        onArchive={archiveFeature}
        onDelete={mutations.deleteFeature}
      />
    </SidebarRowActionsContext.Provider>
  );
}

/**
 * The writes of a conversation of any project, and the checks its archive
 * dialog needs while one is confirmed. Deleting or archiving the open
 * conversation leaves it for a neighbour.
 */
function useCrossProjectFeatureActions(feature: Feature | null) {
  const activeFeatureId = useRouteFeatureIds().featureId;
  const projectId = feature?.project_id ?? 0;
  const enabled = feature !== null;
  const { data: projectFeatures = NO_FEATURES } = useListFeatures(
    { project_id: projectId, include_archived: true },
    { query: { enabled } },
  );
  const { data: worktrees = NO_WORKTREES } = useListFeatureWorktrees(
    { project_id: projectId },
    { query: { enabled, staleTime: FEATURE_WORKTREES_STALE_MS } },
  );
  const activeFeatures = useMemo(
    () => projectFeatures.filter((candidate) => candidate.status === "active"),
    [projectFeatures],
  );
  const worktreeByFeatureId = useMemo(
    () => new Map(worktrees.map((worktree) => [worktree.feature_id, worktree])),
    [worktrees],
  );
  const confirmed = useMemo(() => (feature ? [feature] : NO_FEATURES), [feature]);
  const confirmation = useFeatureArchiveConfirmation(
    feature?.id ?? null,
    confirmed,
    worktreeByFeatureId,
  );
  const archiveFeature = useArchiveFeatureAction({
    activeFeatureId,
    activeFeatures,
    projectId: feature?.project_id ?? null,
  });
  const mutations = useFeatureRowMutations({ activeFeatureId, activeFeatures, projectId });
  return { confirmation, archiveFeature, mutations };
}

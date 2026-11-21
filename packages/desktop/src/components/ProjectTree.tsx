import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  type Project,
  useDeleteProject,
  getListProjectsQueryKey,
  useCreateFeature,
} from "../api/generated";
import { useArchiveProjectSessionsAction } from "@/hooks/useArchiveProjectSessionsAction";
import { useOrderedProjects } from "@/hooks/useOrderedProjects";
import { useProjectExpansion } from "@/hooks/useProjectExpansion";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { ProjectRowActions, ProjectRowContextMenu } from "./ProjectRowMenus";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";
import { invalidateByUrlPrefix } from "@/lib/queryClient";
import { useAddProjectAtPath } from "@/hooks/useAddProjectAtPath";
import { useNewProjectOnboarding } from "@/lib/project-onboarding";
import { apiErrorMessage } from "@/lib/api-errors";
import { toast } from "sonner";
import { SidebarProjectsHeader } from "./SidebarProjectsHeader";
import { ProjectFeatures } from "./ProjectFeatures";
import { desktopBridge, isDesktopShell } from "@/lib/desktop-bridge";
import { ProjectRowButton, ProjectRowLabel } from "./ProjectRowButton";
import { ProjectTreeDialogs } from "./ProjectTreeDialogs";
import type { ProjectLocationTarget } from "./ProjectLocationDialog";
import { FilteredProjectList } from "./FilteredProjectList";
import type { ProjectFilterMatch } from "@/hooks/useSidebarFilterMatches";
import { useSidebarFilterQuery } from "@/stores/sidebar-filter-store";
import { ProjectRowAttention } from "./SidebarAttentionProvider";
import { useRevealActiveRow } from "@/hooks/useRevealActiveRow";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { SampleScope, useSidebarSamplePreview } from "./SidebarSampleProvider";
import { SidebarCrossProjectList } from "./SidebarCrossProjectList";
import { STICKY_HEADER_CLASS } from "./SidebarLensGroupHeader";
import { useSidebarListMode } from "@/hooks/useSidebarViews";
import { useSidebarSectionFold, useSidebarSectionReorder } from "@/hooks/useSidebarSections";
import { SidebarSampleTree } from "./SidebarSampleTree";
import { SidebarSampleRail } from "./SidebarSampleRail";

interface ProjectTreeProps {
  activeProjectId: number | null;
  activeFeatureId: number | null;
  onSelectFeature: (featureId: number) => void;
}

type ProjectSummary = ReturnType<typeof useOrderedProjects>["projects"][number];
type ProjectDialogTarget = {
  id: number;
  name: string;
  authoringTarget?: Project["authoring_target"];
};

function useProjectTreeMutations(
  projects: ProjectSummary[],
  activeProjectId: number | null,
  activeFeatureId: number | null,
) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pendingProjectIdRef = useRef(0);
  const deleteProject = useDeleteProject({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
      },
    },
  });
  const archiveProjectSessions = useArchiveProjectSessionsAction({
    activeFeatureId,
    projectId: activeProjectId ?? -1,
  });
  const createSession = useCreateFeature({
    mutation: {
      onSuccess: (session) => {
        void invalidateByUrlPrefix(queryClient, "/api/features");
        const projectId = pendingProjectIdRef.current;
        const project = projects.find((candidate) => candidate.id === projectId);
        void navigate({
          to: "/ws-session/$sessionId",
          params: { sessionId: wsSessionIdFromFeature(session.id) },
          search: { cwd: project?.path ?? "", featureId: session.id, projectId },
        });
      },
    },
  });
  // The stable parts only: the mutation results are new objects every render,
  // and the controller (with every project row memoized on it) follows this.
  const { isPending: isArchivingSessions, mutateAsync: archiveSessions } = archiveProjectSessions;
  const { mutate: createSessionMutate } = createSession;
  const { mutate: deleteProjectMutate } = deleteProject;
  return useMemo(
    () => ({
      archiveProjectSessions: { isPending: isArchivingSessions, mutateAsync: archiveSessions },
      createSession: { mutate: createSessionMutate },
      deleteProject: { mutate: deleteProjectMutate },
      pendingProjectIdRef,
    }),
    [archiveSessions, createSessionMutate, deleteProjectMutate, isArchivingSessions],
  );
}

function useProjectTreeController(props: ProjectTreeProps) {
  const ordered = useOrderedProjects();
  const [isAddingProject, setIsAddingProject] = useState(false);
  const onboarding = useNewProjectOnboarding();
  const addProjectAtPath = useAddProjectAtPath();
  const mutations = useProjectTreeMutations(
    ordered.projects,
    props.activeProjectId,
    props.activeFeatureId,
  );
  const revealActive = useSidebarOption("revealActive");
  const expansion = useProjectExpansion(revealActive === "off" ? null : props.activeProjectId);
  const { setExpanded: setProjectExpanded } = expansion;
  const [settingsProject, setSettingsProject] = useState<ProjectDialogTarget | null>(null);
  const [importProject, setImportProject] = useState<ProjectDialogTarget | null>(null);
  const [deleteProject, setDeleteProject] = useState<ProjectDialogTarget | null>(null);
  const [archiveSessionsProject, setArchiveSessionsProject] = useState<ProjectDialogTarget | null>(
    null,
  );
  const [locationTarget, setLocationTarget] = useState<ProjectLocationTarget | null>(null);
  const startSession = useCallback(
    (projectId: number) => {
      setProjectExpanded(projectId, true);
      mutations.pendingProjectIdRef.current = projectId;
      mutations.createSession.mutate({ data: { project_id: projectId, type: "ws-session" } });
    },
    [mutations, setProjectExpanded],
  );
  const { maybeOnboard } = onboarding;
  const addProject = useCallback(async () => {
    setIsAddingProject(true);
    try {
      const folder = await desktopBridge.pickDirectory();
      if (!folder) return;
      const project = await addProjectAtPath(folder);
      maybeOnboard({ id: project.id, name: project.name });
    } catch (error) {
      toast.error(apiErrorMessage(error, "Couldn't add the project"));
    } finally {
      setIsAddingProject(false);
    }
  }, [addProjectAtPath, maybeOnboard]);
  return useMemo(
    () => ({
      addProject,
      archiveSessionsProject,
      deleteProject,
      expansion,
      importProject,
      isAddingProject,
      locationTarget,
      mutations,
      onboarding,
      ordered,
      setArchiveSessionsProject,
      setDeleteProject,
      setImportProject,
      setLocationTarget,
      setSettingsProject,
      settingsProject,
      startSession,
    }),
    [
      addProject,
      archiveSessionsProject,
      deleteProject,
      expansion,
      importProject,
      isAddingProject,
      locationTarget,
      mutations,
      onboarding,
      ordered,
      settingsProject,
      startSession,
    ],
  );
}

export type ProjectTreeController = ReturnType<typeof useProjectTreeController>;

export function ProjectTree(props: ProjectTreeProps) {
  const controller = useProjectTreeController(props);
  const filterQuery = useSidebarFilterQuery();
  const treeRef = useRef<HTMLDivElement>(null);
  const projectSort = useSidebarOption("projectSort");
  const mode = useSidebarListMode();
  // A cross-project list reveals its own open row (it is virtualized).
  useRevealActiveRow(treeRef, mode.kind === "tree" ? props.activeFeatureId : null);
  const showsSamples = useSidebarSamplePreview() !== null;
  const fold = useSidebarSectionFold("projects");
  const reorder = useSidebarSectionReorder("projects");
  const { refresh } = controller.ordered;
  const refreshProjects = useCallback(() => void refresh(), [refresh]);
  return (
    <div
      data-sidebar-section="projects"
      {...reorder.target}
      className="relative flex min-w-0 flex-col gap-2 not-last:mb-3"
    >
      <SidebarProjectsHeader
        fold={fold}
        dragHandle={reorder.handle}
        onAddProject={controller.addProject}
        isAddingProject={controller.isAddingProject}
        canAddProject={isDesktopShell()}
        onRefresh={mode.kind !== "tree" || projectSort !== "frozen" ? undefined : refreshProjects}
        isRefreshing={controller.ordered.isRefreshing}
      />
      {!fold.expanded ? null : showsSamples ? (
        <div data-sidebar-sample className="flex min-w-0 flex-col gap-0.5 px-1">
          <SampleScope>
            <SidebarSampleTree />
            <SidebarSampleRail />
          </SampleScope>
        </div>
      ) : (
        <div ref={treeRef} data-sidebar-tree className="flex min-w-0 flex-col gap-0.5 px-1">
          {mode.kind !== "tree" ? (
            <SidebarCrossProjectList
              mode={mode}
              activeFeatureId={props.activeFeatureId}
              onSelectFeature={props.onSelectFeature}
            />
          ) : (
            <ProjectTreeRows props={props} controller={controller} filterQuery={filterQuery} />
          )}
        </div>
      )}
      <ProjectTreeDialogs controller={controller} />
    </div>
  );
}

function ProjectTreeRows({
  props,
  controller,
  filterQuery,
}: {
  props: ProjectTreeProps;
  controller: ProjectTreeController;
  filterQuery: string;
}) {
  return (
    <>
      {filterQuery ? (
        <FilteredProjectList
          projects={controller.ordered.projects}
          query={filterQuery}
          renderProject={(project, match) => (
            <ProjectTreeRow
              key={project.id}
              project={project}
              {...rowRouteProps(props, project.id)}
              controller={controller}
              filterMatch={match}
            />
          )}
        />
      ) : (
        controller.ordered.projects.map((project) => (
          <ProjectTreeRow
            key={project.id}
            project={project}
            {...rowRouteProps(props, project.id)}
            controller={controller}
          />
        ))
      )}
      {controller.ordered.projects.length === 0 && (
        <p className="px-2 py-4 text-center text-xs text-muted-foreground">No projects yet</p>
      )}
    </>
  );
}

/** Only the active project's row gets the active conversation, so a switch leaves the others alone. */
function rowRouteProps(props: ProjectTreeProps, projectId: number) {
  const isActive = props.activeProjectId === projectId;
  return {
    isActive,
    activeFeatureId: isActive ? props.activeFeatureId : null,
    onSelectFeature: props.onSelectFeature,
  };
}

interface ProjectTreeRowProps {
  project: ProjectSummary;
  isActive: boolean;
  activeFeatureId: number | null;
  onSelectFeature: (featureId: number) => void;
  controller: ProjectTreeController;
  /** Set while the sidebar filter is active: the row is held open on its matches. */
  filterMatch?: ProjectFilterMatch;
}

/**
 * Memoized, like its header: a conversation switch re-renders the active
 * project's conversation list, never the other projects or the menus.
 */
const ProjectTreeRow = memo(function ProjectTreeRow({
  project,
  isActive,
  activeFeatureId,
  onSelectFeature,
  controller,
  filterMatch,
}: ProjectTreeRowProps) {
  const isFiltering = filterMatch !== undefined;
  const isExpanded = isFiltering || controller.expansion.expandedIds.has(project.id);
  const { setExpanded } = controller.expansion;
  // Folding a project the filter holds open would silently flip its remembered state.
  const toggle = useCallback((): void => {
    if (!isFiltering) setExpanded(project.id, !isExpanded);
  }, [isExpanded, isFiltering, project.id, setExpanded]);
  return (
    <div>
      <ProjectTreeRowHeader
        project={project}
        isActive={isActive}
        isExpanded={isExpanded}
        controller={controller}
        onToggle={toggle}
      />
      {isExpanded && (
        <div className="sidebar-project-children" data-active={isActive || undefined}>
          <ProjectFeatures
            projectId={project.id}
            projectPath={project.path}
            activeFeatureId={activeFeatureId}
            onSelectFeature={onSelectFeature}
            filterMatch={filterMatch}
          />
        </div>
      )}
    </div>
  );
});

const ProjectTreeRowHeader = memo(function ProjectTreeRowHeader({
  project,
  isActive,
  isExpanded,
  controller,
  onToggle,
}: {
  project: ProjectSummary;
  isActive: boolean;
  isExpanded: boolean;
  controller: ProjectTreeController;
  onToggle: () => void;
}) {
  const sticky = useSidebarOption("stickyHeaders") && isExpanded;
  return (
    /* Held at the top while the project's conversations scroll under it. */
    <div
      data-sidebar-sticky-header={sticky || undefined}
      className={sticky ? STICKY_HEADER_CLASS : undefined}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <ProjectRowButton projectId={project.id} isActive={isActive} onClick={onToggle}>
            <ProjectRowLabel
              projectId={project.id}
              name={project.name}
              expanded={isExpanded}
              folderMissing={project.path_missing}
            />
            {!isExpanded && <ProjectRowAttention projectId={project.id} />}
            <ProjectRowActions project={project} controller={controller} />
          </ProjectRowButton>
        </ContextMenuTrigger>
        <ProjectRowContextMenu project={project} controller={controller} />
      </ContextMenu>
    </div>
  );
});

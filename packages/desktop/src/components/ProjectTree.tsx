import { useCallback, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  type Project,
  useCreateProject,
  useDeleteProject,
  getListProjectsQueryKey,
  getGetProjectSettingsQueryKey,
  useCreateFeature,
  useSetProjectSetting,
} from "../api/generated";
import { useArchiveProjectSessionsAction } from "@/hooks/useArchiveProjectSessionsAction";
import { useOrderedProjects } from "@/hooks/useOrderedProjects";
import { useProjectExpansion } from "@/hooks/useProjectExpansion";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { ProjectRowActions, ProjectRowContextMenu } from "./ProjectRowMenus";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";
import { invalidateByUrlPrefix } from "@/lib/queryClient";
import { PROJECT_COLORS } from "@/lib/project-colors";
import { useNewProjectOnboarding } from "@/lib/project-onboarding";
import { apiErrorMessage } from "@/lib/api-errors";
import { toast } from "sonner";
import { SidebarProjectsHeader } from "./SidebarProjectsHeader";
import { ProjectFeatures } from "./ProjectFeatures";
import { desktopBridge, isDesktopShell } from "@/lib/desktop-bridge";
import { ProjectRowButton, ProjectRowLabel } from "./ProjectRowButton";
import { ProjectTreeDialogs } from "./ProjectTreeDialogs";
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
  maybeOnboard: (project: ProjectDialogTarget) => void,
  activeProjectId: number | null,
  activeFeatureId: number | null,
) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const pendingProjectIdRef = useRef(0);
  const setProjectSetting = useSetProjectSetting({
    mutation: {
      onSuccess: (_data, variables) => {
        void queryClient.invalidateQueries({
          queryKey: getGetProjectSettingsQueryKey(variables.id),
        });
      },
      onError: (error) => {
        toast.error(`Could not save project setting: ${apiErrorMessage(error, "Unknown error")}`);
      },
    },
  });
  const createProject = useCreateProject({
    mutation: {
      onSuccess: (project) => {
        const color = PROJECT_COLORS[project.id % PROJECT_COLORS.length];
        setProjectSetting.mutate({ id: project.id, data: { key: "color", value: color } });
        void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
        maybeOnboard({ id: project.id, name: project.name });
      },
    },
  });
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
  return useMemo(
    () => ({
      archiveProjectSessions,
      createProject,
      createSession,
      deleteProject,
      pendingProjectIdRef,
    }),
    [archiveProjectSessions, createProject, createSession, deleteProject],
  );
}

function useProjectTreeController(props: ProjectTreeProps) {
  const ordered = useOrderedProjects();
  const [isSelectingFolder, setIsSelectingFolder] = useState(false);
  const onboarding = useNewProjectOnboarding();
  const mutations = useProjectTreeMutations(
    ordered.projects,
    onboarding.maybeOnboard,
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
  const startSession = useCallback(
    (projectId: number) => {
      setProjectExpanded(projectId, true);
      mutations.pendingProjectIdRef.current = projectId;
      mutations.createSession.mutate({ data: { project_id: projectId, type: "ws-session" } });
    },
    [mutations, setProjectExpanded],
  );
  const addProject = useCallback(async () => {
    setIsSelectingFolder(true);
    try {
      const folder = await desktopBridge.pickDirectory();
      if (!folder) return;
      mutations.createProject.mutate({
        data: { name: folder.split("/").pop() ?? folder, path: folder },
      });
    } finally {
      setIsSelectingFolder(false);
    }
  }, [mutations.createProject]);
  return useMemo(
    () => ({
      addProject,
      archiveSessionsProject,
      deleteProject,
      expansion,
      importProject,
      isSelectingFolder,
      mutations,
      onboarding,
      ordered,
      setArchiveSessionsProject,
      setDeleteProject,
      setImportProject,
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
      isSelectingFolder,
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
        isAddingProject={
          controller.isSelectingFolder || controller.mutations.createProject.isPending
        }
        canAddProject={isDesktopShell()}
        onRefresh={
          mode.kind !== "tree" || projectSort !== "frozen"
            ? undefined
            : () => void controller.ordered.refresh()
        }
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
              props={props}
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
            props={props}
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

function ProjectTreeRow({
  project,
  props,
  controller,
  filterMatch,
}: {
  project: ProjectSummary;
  props: ProjectTreeProps;
  controller: ProjectTreeController;
  /** Set while the sidebar filter is active: the row is held open on its matches. */
  filterMatch?: ProjectFilterMatch;
}) {
  const isFiltering = filterMatch !== undefined;
  const isExpanded = isFiltering || controller.expansion.expandedIds.has(project.id);
  const isActive = props.activeProjectId === project.id;
  const sticky = useSidebarOption("stickyHeaders") && isExpanded;
  // Folding a project the filter holds open would silently flip its remembered state.
  const toggle = (): void => {
    if (!isFiltering) controller.expansion.setExpanded(project.id, !isExpanded);
  };
  return (
    <div>
      {/* Held at the top while the project's conversations scroll under it. */}
      <div
        data-sidebar-sticky-header={sticky || undefined}
        className={sticky ? STICKY_HEADER_CLASS : undefined}
      >
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <ProjectRowButton projectId={project.id} isActive={isActive} onClick={toggle}>
              <ProjectRowLabel projectId={project.id} name={project.name} expanded={isExpanded} />
              {!isExpanded && <ProjectRowAttention projectId={project.id} />}
              <ProjectRowActions project={project} controller={controller} />
            </ProjectRowButton>
          </ContextMenuTrigger>
          <ProjectRowContextMenu project={project} controller={controller} />
        </ContextMenu>
      </div>
      {isExpanded && (
        <div className="sidebar-project-children" data-active={isActive || undefined}>
          <ProjectFeatures
            projectId={project.id}
            projectPath={project.path}
            activeFeatureId={isActive ? props.activeFeatureId : null}
            onSelectFeature={props.onSelectFeature}
            filterMatch={filterMatch}
          />
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Archive,
  ChevronRight,
  ChevronDown,
  Download,
  Ellipsis,
  PlusIcon,
  Settings,
  Trash2,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateProject,
  useDeleteProject,
  getListProjectsQueryKey,
  getGetProjectSettingsQueryKey,
  useCreateFeature,
  useSetProjectSetting,
} from "../api/generated";
import { useArchiveProjectSessionsAction } from "@/hooks/useArchiveProjectSessionsAction";
import { useOrderedProjects } from "@/hooks/useOrderedProjects";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ContextMenuActionItem } from "@/components/ContextMenuActionItem";
import { wsSessionIdFromFeature } from "@/lib/ws-session-id";
import { invalidateByUrlPrefix } from "@/lib/queryClient";
import { clearProjectAutoExpandSkip, shouldSkipProjectAutoExpand } from "@/lib/project-auto-expand";
import { ProjectBadge } from "@/components/ProjectBadge";
import { PROJECT_COLORS } from "@/lib/project-colors";
import { useNewProjectOnboarding } from "@/lib/project-onboarding";
import { apiErrorMessage } from "@/lib/api-errors";
import { toast } from "sonner";
import { SidebarProjectsHeader } from "./SidebarProjectsHeader";
import { ProjectFeatures } from "./ProjectFeatures";
import { desktopBridge, isDesktopShell } from "@/lib/desktop-bridge";
import { ProjectRowButton } from "./ProjectRowButton";
import { ProjectTreeDialogs } from "./ProjectTreeDialogs";

interface ProjectTreeProps {
  activeProjectId: number | null;
  activeFeatureId: number | null;
  onSelectFeature: (featureId: number) => void;
}

type ProjectSummary = ReturnType<typeof useOrderedProjects>["projects"][number];
type ProjectDialogTarget = { id: number; name: string };

function useProjectTreeMutations(
  projects: ProjectSummary[],
  maybeOnboard: (project: ProjectDialogTarget) => void,
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
  const archiveProjectSessions = useArchiveProjectSessionsAction();
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
  const mutations = useProjectTreeMutations(ordered.projects, onboarding.maybeOnboard);
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [settingsProject, setSettingsProject] = useState<ProjectDialogTarget | null>(null);
  const [importProject, setImportProject] = useState<ProjectDialogTarget | null>(null);
  const [deleteProject, setDeleteProject] = useState<ProjectDialogTarget | null>(null);
  const [archiveSessionsProject, setArchiveSessionsProject] = useState<ProjectDialogTarget | null>(
    null,
  );
  useEffect(() => {
    const activeId = props.activeProjectId;
    // Leaving the project list (e.g. opening Settings) must not leave a stale
    // pinned-navigation marker behind: returning to the project later is an
    // ordinary navigation and should expand it.
    if (activeId == null) {
      clearProjectAutoExpandSkip();
      return;
    }
    // A pinned-row navigation marks its project so the tree stays folded.
    if (shouldSkipProjectAutoExpand(activeId)) return;
    clearProjectAutoExpandSkip();
    setExpanded((previous) => ({ ...previous, [activeId]: true }));
  }, [props.activeProjectId]);
  const startSession = useCallback(
    (projectId: number) => {
      setExpanded((previous) => ({ ...previous, [projectId]: true }));
      mutations.pendingProjectIdRef.current = projectId;
      mutations.createSession.mutate({ data: { project_id: projectId, type: "ws-session" } });
    },
    [mutations],
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
      expanded,
      importProject,
      isSelectingFolder,
      mutations,
      onboarding,
      ordered,
      setArchiveSessionsProject,
      setDeleteProject,
      setExpanded,
      setImportProject,
      setSettingsProject,
      settingsProject,
      startSession,
    }),
    [
      addProject,
      archiveSessionsProject,
      deleteProject,
      expanded,
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
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-2 overflow-hidden">
      <SidebarProjectsHeader
        onAddProject={controller.addProject}
        isAddingProject={
          controller.isSelectingFolder || controller.mutations.createProject.isPending
        }
        canAddProject={isDesktopShell()}
        onRefresh={() => void controller.ordered.refresh()}
        isRefreshing={controller.ordered.isRefreshing}
      />
      <ScrollArea className="flex-1 min-h-0 min-w-0 overflow-hidden">
        <div className="flex min-w-0 flex-col gap-0.5 px-1">
          {controller.ordered.projects.map((project) => (
            <ProjectTreeRow
              key={project.id}
              project={project}
              props={props}
              controller={controller}
            />
          ))}
          {controller.ordered.projects.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">No projects yet</p>
          )}
        </div>
      </ScrollArea>
      <ProjectTreeDialogs controller={controller} />
    </div>
  );
}

function ProjectTreeRow({
  project,
  props,
  controller,
}: {
  project: ProjectSummary;
  props: ProjectTreeProps;
  controller: ProjectTreeController;
}) {
  const isExpanded = controller.expanded[project.id] ?? false;
  const isActive = props.activeProjectId === project.id;
  const toggle = (): void =>
    controller.setExpanded((previous) => ({ ...previous, [project.id]: !previous[project.id] }));
  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <ProjectRowButton projectId={project.id} isActive={isActive} onClick={toggle}>
            {isExpanded ? (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span
              data-sidebar-project-badge
              className="inline-flex size-3.5 shrink-0 items-center justify-center"
            >
              <ProjectBadge projectId={project.id} className="max-w-none" />
            </span>
            <span className="min-w-0 truncate">{project.name}</span>
            <ProjectRowActions project={project} controller={controller} />
          </ProjectRowButton>
        </ContextMenuTrigger>
        <ProjectRowContextMenu project={project} controller={controller} />
      </ContextMenu>
      {isExpanded && (
        <ProjectFeatures
          projectId={project.id}
          projectPath={project.path}
          activeFeatureId={isActive ? props.activeFeatureId : null}
          onSelectFeature={props.onSelectFeature}
        />
      )}
    </div>
  );
}

function ProjectRowActions({
  project,
  controller,
}: {
  project: ProjectSummary;
  controller: ProjectTreeController;
}) {
  const target = { id: project.id, name: project.name };
  return (
    <div className="ml-auto flex shrink-0 items-center gap-0.5">
      <span
        role="button"
        tabIndex={0}
        className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-accent"
        onClick={(event) => {
          event.stopPropagation();
          controller.startSession(project.id);
        }}
      >
        <PlusIcon className="h-3.5 w-3.5" />
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <span
            role="button"
            tabIndex={0}
            aria-label="Project actions"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-accent can-hover:opacity-0 can-hover:focus-visible:opacity-100 can-hover:group-hover/project:opacity-100"
            onClick={(event) => event.stopPropagation()}
          >
            <Ellipsis className="h-3.5 w-3.5" />
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={(event) => {
              event.stopPropagation();
              controller.setSettingsProject(target);
            }}
          >
            <Settings className="size-4" /> Project Settings
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(event) => {
              event.stopPropagation();
              controller.setImportProject(target);
            }}
          >
            <Download className="size-4" /> Import existing sessions
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={(event) => {
              event.stopPropagation();
              controller.setArchiveSessionsProject(target);
            }}
          >
            <Archive className="size-4" /> Archive all sessions
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={(event) => {
              event.stopPropagation();
              controller.setDeleteProject(target);
            }}
          >
            <Trash2 className="size-4" /> Delete Project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ProjectRowContextMenu({
  project,
  controller,
}: {
  project: ProjectSummary;
  controller: ProjectTreeController;
}) {
  const target = { id: project.id, name: project.name };
  return (
    <ContextMenuContent>
      <ContextMenuActionItem icon={PlusIcon} onSelect={() => controller.startSession(project.id)}>
        New Session
      </ContextMenuActionItem>
      <ContextMenuSeparator />
      <ContextMenuActionItem icon={Settings} onSelect={() => controller.setSettingsProject(target)}>
        Project Settings
      </ContextMenuActionItem>
      <ContextMenuActionItem icon={Download} onSelect={() => controller.setImportProject(target)}>
        Import existing sessions
      </ContextMenuActionItem>
      <ContextMenuActionItem
        icon={Archive}
        onSelect={() => controller.setArchiveSessionsProject(target)}
      >
        Archive all sessions
      </ContextMenuActionItem>
      <ContextMenuActionItem
        icon={Trash2}
        variant="destructive"
        onSelect={() => controller.setDeleteProject(target)}
      >
        Delete Project
      </ContextMenuActionItem>
    </ContextMenuContent>
  );
}

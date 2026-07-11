import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import {
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
import { ProjectColorDot } from "@/hooks/useProjectColor";
import { PROJECT_COLORS } from "@/lib/project-colors";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";
import { NewProjectOnboardingDialog } from "./NewProjectOnboardingDialog";
import { useNewProjectOnboarding } from "@/lib/project-onboarding";
import { apiErrorMessage } from "@/lib/api-errors";
import { toast } from "sonner";
import { SidebarProjectsHeader } from "./SidebarProjectsHeader";
import { ProjectFeatures } from "./ProjectFeatures";
import { ConfirmDialog } from "./ConfirmDialog";
import { ImportConversationsDialog } from "./import/ImportConversationsDialog";
import { desktopBridge, isDesktopShell } from "@/lib/desktop-bridge";
import { ShortcutHintsProvider, useNavShortcutHint } from "@/hooks/useNavShortcutHints";
import { useSidebarCollapsed } from "@/components/SidebarContext";
import { SidebarShortcutBadge } from "@/components/SidebarShortcutBadge";

interface ProjectTreeProps {
  activeProjectId: number | null;
  activeFeatureId: number | null;
  onSelectFeature: (featureId: number) => void;
}

export function ProjectTree({
  activeProjectId,
  activeFeatureId,
  onSelectFeature,
}: ProjectTreeProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { projects, isRefreshing, refresh } = useOrderedProjects();
  const { collapsed } = useSidebarCollapsed();

  const [isSelectingFolder, setIsSelectingFolder] = useState(false);
  const { onboardingProject, maybeOnboard, close: closeOnboarding } = useNewProjectOnboarding();

  const setProjectSetting = useSetProjectSetting({
    mutation: {
      onSuccess: (_data, variables) => {
        void queryClient.invalidateQueries({
          queryKey: getGetProjectSettingsQueryKey(variables.id),
        });
      },
      onError: (err: unknown) => {
        toast.error(`Could not save project setting: ${apiErrorMessage(err, "Unknown error")}`);
      },
    },
  });
  const createProjectMutation = useCreateProject({
    mutation: {
      onSuccess: (project) => {
        const color = PROJECT_COLORS[project.id % PROJECT_COLORS.length];
        setProjectSetting.mutate({ id: project.id, data: { key: "color", value: color } });
        void queryClient.invalidateQueries({
          queryKey: getListProjectsQueryKey(),
        });
        // Onboard the freshly-added project (color + worktree defaults) unless
        // the user opted out.
        maybeOnboard({ id: project.id, name: project.name });
      },
    },
  });
  const deleteProjectMutation = useDeleteProject({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: getListProjectsQueryKey(),
        });
      },
    },
  });

  // Track which project the create mutation was triggered for
  const pendingProjectIdRef = useRef(0);

  const createWsSessionMutation = useCreateFeature({
    mutation: {
      onSuccess: (wsSession) => {
        void invalidateByUrlPrefix(queryClient, "/api/features");
        const wsSessionId = wsSessionIdFromFeature(wsSession.id);
        const projectId = pendingProjectIdRef.current;
        const project = projects.find((p) => p.id === projectId);
        void navigate({
          to: "/ws-session/$sessionId",
          params: { sessionId: wsSessionId },
          search: {
            cwd: project?.path ?? "",
            featureId: wsSession.id,
            projectId,
          },
        });
      },
    },
  });

  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [settingsProject, setSettingsProject] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const [importProject, setImportProject] = useState<{
    id: number;
    name: string;
  } | null>(null);
  const [deleteProject, setDeleteProject] = useState<{
    id: number;
    name: string;
  } | null>(null);

  // Auto-expand the active project
  useEffect(() => {
    if (activeProjectId != null) {
      setExpanded((prev) => ({ ...prev, [activeProjectId]: true }));
    }
  }, [activeProjectId]);

  const toggleExpand = (projectId: number) => {
    setExpanded((prev) => ({ ...prev, [projectId]: !prev[projectId] }));
  };

  const handleAddProject = async () => {
    setIsSelectingFolder(true);
    try {
      const folder = await desktopBridge.pickDirectory();
      if (!folder) return;
      const name = folder.split("/").pop() ?? folder;
      createProjectMutation.mutate({ data: { name, path: folder } });
    } finally {
      setIsSelectingFolder(false);
    }
  };

  return (
    <ShortcutHintsProvider enabled={!collapsed}>
      <div className="flex h-full min-h-0 min-w-0 flex-col gap-2 overflow-hidden">
        <SidebarProjectsHeader
          onAddProject={handleAddProject}
          isAddingProject={isSelectingFolder || createProjectMutation.isLoading}
          canAddProject={isDesktopShell()}
          onRefresh={() => void refresh()}
          isRefreshing={isRefreshing}
        />

        <ScrollArea className="flex-1 min-h-0 min-w-0 overflow-hidden">
          <div className="flex min-w-0 flex-col gap-0.5 px-1">
            {projects.map((project) => {
              const isExpanded = expanded[project.id] ?? false;
              const isActive = activeProjectId === project.id;

              return (
                <div key={project.id}>
                  {/* Project row */}
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <ProjectRowButton
                        projectId={project.id}
                        isActive={isActive}
                        onClick={() => toggleExpand(project.id)}
                      >
                        {isExpanded ? (
                          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <ProjectColorDot projectId={project.id} />
                        <span className="min-w-0 truncate">{project.name}</span>

                        <div className="ml-auto flex shrink-0 items-center gap-0.5">
                          {/* New session */}
                          <span
                            role="button"
                            tabIndex={0}
                            className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-accent"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpanded((prev) => ({ ...prev, [project.id]: true }));
                              pendingProjectIdRef.current = project.id;
                              createWsSessionMutation.mutate({
                                data: { project_id: project.id, type: "ws-session" },
                              });
                            }}
                          >
                            <PlusIcon className="h-3.5 w-3.5" />
                          </span>

                          {/* Project menu */}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <span
                                role="button"
                                tabIndex={0}
                                className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-accent can-hover:opacity-0 can-hover:focus-visible:opacity-100 can-hover:group-hover/project:opacity-100"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Ellipsis className="h-3.5 w-3.5" />
                              </span>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSettingsProject({
                                    id: project.id,
                                    name: project.name,
                                  });
                                }}
                              >
                                <Settings className="size-4" /> Project Settings
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setImportProject({
                                    id: project.id,
                                    name: project.name,
                                  });
                                }}
                              >
                                <Download className="size-4" /> Import existing sessions
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setDeleteProject({
                                    id: project.id,
                                    name: project.name,
                                  });
                                }}
                              >
                                <Trash2 className="size-4" /> Delete Project
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </ProjectRowButton>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuActionItem
                        icon={PlusIcon}
                        onSelect={() => {
                          setExpanded((prev) => ({ ...prev, [project.id]: true }));
                          pendingProjectIdRef.current = project.id;
                          createWsSessionMutation.mutate({
                            data: { project_id: project.id, type: "ws-session" },
                          });
                        }}
                      >
                        New Session
                      </ContextMenuActionItem>
                      <ContextMenuSeparator />
                      <ContextMenuActionItem
                        icon={Settings}
                        onSelect={() => setSettingsProject({ id: project.id, name: project.name })}
                      >
                        Project Settings
                      </ContextMenuActionItem>
                      <ContextMenuActionItem
                        icon={Download}
                        onSelect={() => setImportProject({ id: project.id, name: project.name })}
                      >
                        Import existing sessions
                      </ContextMenuActionItem>
                      <ContextMenuActionItem
                        icon={Trash2}
                        variant="destructive"
                        onSelect={() => setDeleteProject({ id: project.id, name: project.name })}
                      >
                        Delete Project
                      </ContextMenuActionItem>
                    </ContextMenuContent>
                  </ContextMenu>

                  {/* Features (expanded) */}
                  {isExpanded && (
                    <ProjectFeatures
                      projectId={project.id}
                      projectPath={project.path}
                      activeFeatureId={isActive ? activeFeatureId : null}
                      onSelectFeature={onSelectFeature}
                    />
                  )}
                </div>
              );
            })}

            {projects.length === 0 && (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">No projects yet</p>
            )}
          </div>
        </ScrollArea>

        {settingsProject && (
          <ProjectSettingsDialog
            projectId={settingsProject.id}
            projectName={settingsProject.name}
            open={true}
            onOpenChange={(open) => {
              if (!open) setSettingsProject(null);
            }}
          />
        )}

        {onboardingProject && (
          <NewProjectOnboardingDialog
            projectId={onboardingProject.id}
            projectName={onboardingProject.name}
            open={true}
            onOpenChange={(open) => {
              if (!open) closeOnboarding();
            }}
          />
        )}

        {importProject && (
          <ImportConversationsDialog
            projectId={importProject.id}
            projectName={importProject.name}
            open={true}
            onOpenChange={(open) => {
              if (!open) setImportProject(null);
            }}
          />
        )}

        <ConfirmDialog
          open={deleteProject !== null}
          onOpenChange={(open) => {
            if (!open) setDeleteProject(null);
          }}
          title={`Delete "${deleteProject?.name}"?`}
          description="This will permanently delete the project and all its features, plans, sessions, and settings. This action cannot be undone."
          confirmText="Delete"
          variant="destructive"
          onConfirm={() => {
            if (deleteProject) {
              deleteProjectMutation.mutate({ id: deleteProject.id });
            }
          }}
        />
      </div>
    </ShortcutHintsProvider>
  );
}

interface ProjectRowButtonProps {
  projectId: number;
  isActive: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
  children: ReactNode;
}

/**
 * Project row trigger. Owns its own nav-shortcut registration so `⌘N`
 * activates this row. Forwards the DOM ref so `ContextMenuTrigger asChild`
 * can still attach its own listeners.
 */
const ProjectRowButton = forwardRef<HTMLButtonElement, ProjectRowButtonProps>(
  function ProjectRowButton({ projectId, isActive, onClick, children, ...rest }, forwardedRef) {
    const { navRef, badgeRef } = useNavShortcutHint<HTMLButtonElement>();
    const assignRef = (node: HTMLButtonElement | null): void => {
      navRef.current = node;
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    };
    return (
      <button
        ref={assignRef}
        type="button"
        data-nav-item
        data-nav-type="project"
        data-nav-id={String(projectId)}
        onClick={onClick}
        className={`group/project relative flex w-full min-w-0 items-center gap-1 rounded-md px-1.5 py-1.5 text-left text-sm outline-none transition-colors ${
          isActive ? "text-accent-foreground font-medium" : "hover:bg-accent/50"
        }`}
        {...rest}
      >
        <SidebarShortcutBadge ref={badgeRef} />
        {children}
      </button>
    );
  },
);

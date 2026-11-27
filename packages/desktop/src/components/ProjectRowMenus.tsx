import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import {
  Archive,
  Download,
  Ellipsis,
  FolderInput,
  FolderSearch,
  Pencil,
  PlusIcon,
  Settings,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ContextMenuContent, ContextMenuSeparator } from "@/components/ui/context-menu";
import { ContextMenuActionItem } from "@/components/ContextMenuActionItem";
import type { ProjectTreeController } from "./ProjectTree";

type ProjectSummary = ProjectTreeController["ordered"]["projects"][number];

interface LocationAction {
  key: string;
  icon: LucideIcon;
  label: string;
  run: () => void;
}

/** Rename, move, or (when its folder is gone) locate the project. Plugin
 * authoring projects are named and placed by Cadencr. */
function locationActions(
  project: ProjectSummary,
  controller: ProjectTreeController,
): LocationAction[] {
  if (project.authoring_target) return [];
  const open = (mode: "rename" | "move" | "locate") => () =>
    controller.setLocationTarget({
      id: project.id,
      name: project.name,
      path: project.path,
      folderMissing: project.path_missing,
      mode,
    });
  const rename = {
    key: "rename",
    icon: Pencil,
    label: translateUi("project.rowMenus.rename", "Rename…"),
    run: open("rename"),
  };
  return project.path_missing
    ? [
        rename,
        {
          key: "locate",
          icon: FolderSearch,
          label: translateUi("project.rowMenus.locateFolder", "Locate folder…"),
          run: open("locate"),
        },
      ]
    : [
        rename,
        {
          key: "move",
          icon: FolderInput,
          label: translateUi("project.rowMenus.moveFolder", "Move folder…"),
          run: open("move"),
        },
      ];
}

export function ProjectRowActions({
  project,
  controller,
}: {
  project: ProjectSummary;
  controller: ProjectTreeController;
}) {
  const { t } = useUiTranslation();
  return (
    // Hidden (not just transparent) until hover, keyboard focus, or an open menu,
    // so the actions don't reserve width and truncate the project name.
    <div className="ml-auto flex shrink-0 items-center gap-0.5 can-hover:hidden can-hover:group-hover/project:flex can-hover:group-focus-visible/project:flex can-hover:has-data-[state=open]:flex">
      <span
        role="button"
        tabIndex={0}
        aria-label={t("project.rowMenus.newSession", "New Session")}
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
            aria-label={t("project.rowMenus.projectActions", "Project actions")}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-accent"
            onClick={(event) => event.stopPropagation()}
          >
            <Ellipsis className="h-3.5 w-3.5" />
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <ProjectDropdownItems project={project} controller={controller} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ProjectDropdownItems({
  project,
  controller,
}: {
  project: ProjectSummary;
  controller: ProjectTreeController;
}) {
  const { t } = useUiTranslation();
  const target = {
    id: project.id,
    name: project.name,
    authoringTarget: project.authoring_target,
  };
  return (
    <>
      <DropdownMenuItem
        onClick={(event) => {
          event.stopPropagation();
          controller.setSettingsProject(target);
        }}
      >
        <Settings className="size-4" /> {t("project.rowMenus.projectSettings", "Project Settings")}
      </DropdownMenuItem>
      {locationActions(project, controller).map(({ key, icon: Icon, label, run }) => (
        <DropdownMenuItem
          key={key}
          onClick={(event) => {
            event.stopPropagation();
            run();
          }}
        >
          <Icon className="size-4" /> {label}
        </DropdownMenuItem>
      ))}
      <DropdownMenuItem
        onClick={(event) => {
          event.stopPropagation();
          controller.setImportProject(target);
        }}
      >
        <Download className="size-4" />{" "}
        {t("project.rowMenus.importExistingSessions", "Import existing sessions")}
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={(event) => {
          event.stopPropagation();
          controller.setArchiveSessionsProject(target);
        }}
      >
        <Archive className="size-4" />{" "}
        {t("project.rowMenus.archiveAllSessions", "Archive all sessions")}
      </DropdownMenuItem>
      <DropdownMenuItem
        className="text-destructive focus:text-destructive"
        onClick={(event) => {
          event.stopPropagation();
          controller.setDeleteProject(target);
        }}
      >
        <Trash2 className="size-4" /> {t("project.rowMenus.deleteProject", "Delete Project")}
      </DropdownMenuItem>
    </>
  );
}

export function ProjectRowContextMenu({
  project,
  controller,
}: {
  project: ProjectSummary;
  controller: ProjectTreeController;
}) {
  const { t } = useUiTranslation();
  const target = {
    id: project.id,
    name: project.name,
    authoringTarget: project.authoring_target,
  };
  return (
    <ContextMenuContent>
      <ContextMenuActionItem icon={PlusIcon} onSelect={() => controller.startSession(project.id)}>
        {t("project.rowMenus.newSession", "New Session")}
      </ContextMenuActionItem>
      <ContextMenuSeparator />
      <ContextMenuActionItem icon={Settings} onSelect={() => controller.setSettingsProject(target)}>
        {t("project.rowMenus.projectSettings", "Project Settings")}
      </ContextMenuActionItem>
      {locationActions(project, controller).map(({ key, icon, label, run }) => (
        <ContextMenuActionItem key={key} icon={icon} onSelect={run}>
          {label}
        </ContextMenuActionItem>
      ))}
      <ContextMenuActionItem icon={Download} onSelect={() => controller.setImportProject(target)}>
        {t("project.rowMenus.importExistingSessions", "Import existing sessions")}
      </ContextMenuActionItem>
      <ContextMenuActionItem
        icon={Archive}
        onSelect={() => controller.setArchiveSessionsProject(target)}
      >
        {t("project.rowMenus.archiveAllSessions", "Archive all sessions")}
      </ContextMenuActionItem>
      <ContextMenuActionItem
        icon={Trash2}
        variant="destructive"
        onSelect={() => controller.setDeleteProject(target)}
      >
        {t("project.rowMenus.deleteProject", "Delete Project")}
      </ContextMenuActionItem>
    </ContextMenuContent>
  );
}

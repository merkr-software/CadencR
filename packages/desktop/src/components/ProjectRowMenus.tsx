import { Archive, Download, Ellipsis, PlusIcon, Settings, Trash2 } from "lucide-react";
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

export function ProjectRowActions({
  project,
  controller,
}: {
  project: ProjectSummary;
  controller: ProjectTreeController;
}) {
  const target = {
    id: project.id,
    name: project.name,
    authoringTarget: project.authoring_target,
  };
  return (
    // Hidden (not just transparent) until hover, keyboard focus, or an open menu,
    // so the actions don't reserve width and truncate the project name.
    <div className="ml-auto flex shrink-0 items-center gap-0.5 can-hover:hidden can-hover:group-hover/project:flex can-hover:group-focus-visible/project:flex can-hover:has-data-[state=open]:flex">
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
            className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-accent"
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

export function ProjectRowContextMenu({
  project,
  controller,
}: {
  project: ProjectSummary;
  controller: ProjectTreeController;
}) {
  const target = {
    id: project.id,
    name: project.name,
    authoringTarget: project.authoring_target,
  };
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

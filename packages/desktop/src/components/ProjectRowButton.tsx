import { useUiTranslation } from "@/lib/i18n/ui";
import { forwardRef, type MouseEventHandler, type ReactElement, type ReactNode } from "react";
import { ChevronDown, ChevronRight, FolderX } from "lucide-react";
import { ProjectBadge } from "@/components/ProjectBadge";
import { SidebarShortcutBadge } from "@/components/SidebarShortcutBadge";
import { PROJECT_ROW_CLASS } from "@/components/SidebarLensGroupHeader";
import { useNavShortcutHint } from "@/hooks/useNavShortcutHints";
import { cn } from "@/lib/utils";

interface ProjectRowButtonProps {
  projectId: number;
  isActive: boolean;
  onClick: MouseEventHandler<HTMLButtonElement>;
  children: ReactNode;
}

/** Project row trigger with nav-shortcut registration and a forwarded context-menu ref. */
export const ProjectRowButton = forwardRef<HTMLButtonElement, ProjectRowButtonProps>(
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
        className={cn(PROJECT_ROW_CLASS, "group/project", isActive && "text-foreground")}
        {...rest}
      >
        <SidebarShortcutBadge ref={badgeRef} />
        {children}
      </button>
    );
  },
);

/** A project row's fold chevron, badge and name: shared by the tree and the display options preview. */
export function ProjectRowLabel({
  projectId,
  name,
  expanded,
  folderMissing = false,
}: {
  projectId: number;
  name: string;
  expanded: boolean;
  /** The folder is not where the project records it; the menu offers to locate it. */
  folderMissing?: boolean;
}): ReactElement {
  const { t } = useUiTranslation();
  return (
    <>
      {expanded ? (
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span
        data-sidebar-project-badge
        className="inline-flex size-3.5 shrink-0 items-center justify-center"
      >
        <ProjectBadge projectId={projectId} className="max-w-none" />
      </span>
      <span className="min-w-0 truncate">{name}</span>
      {folderMissing ? (
        <span
          title={t(
            "project.rowButton.folderNotFoundHint",
            "Folder not found. Locate it from the project menu.",
          )}
          className="shrink-0"
        >
          <FolderX
            aria-label={t("project.rowButton.folderNotFound", "Folder not found")}
            className="size-3.5 text-[var(--acc-yellow)]"
          />
        </span>
      ) : null}
    </>
  );
}

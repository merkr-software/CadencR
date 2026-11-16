import { memo, useCallback, useEffect, useRef, type ReactElement, type ReactNode } from "react";
import { PanelLeft } from "lucide-react";
import { ResizableSidebarLayout } from "@/components/ResizableSidebarLayout";
import { MobileDrawer } from "@/components/MobileDrawer";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useShortcutKeys } from "@/hooks/useShortcutLabel";

interface EditorSidebarLayoutProps {
  sidebarVisible: boolean;
  sidebar: ReactNode;
  editor: ReactNode;
  onToggleSidebar: () => void;
  /** Active file in the focused pane — drives the mobile drawer auto-close. */
  activeFilePath?: string | null;
}

const DEFAULT_WIDTH = 220;
const MIN_WIDTH = 120;
const MAX_WIDTH = 500;

function EditorSidebarLayoutImpl({
  sidebarVisible,
  sidebar,
  editor,
  onToggleSidebar,
  activeFilePath = null,
}: EditorSidebarLayoutProps): ReactElement {
  const isMobile = useIsMobile();
  const toggleSidebarKeys = useShortcutKeys("editor-toggle-sidebar");
  const collapsed = !sidebarVisible;
  const handleCollapsedChange = useCallback(
    (nextCollapsed: boolean): void => {
      if (nextCollapsed !== collapsed) onToggleSidebar();
    },
    [collapsed, onToggleSidebar],
  );

  // Phones can't host the side-by-side tree+editor split — at 390px both halves
  // are unusable. Render the editor full-width with the file tree as an
  // overlay drawer (matching the app shell's mobile sidebar), so we rely on a
  // single column instead of a resizable split.
  if (isMobile) {
    return (
      <MobileEditorLayout
        collapsed={collapsed}
        sidebar={sidebar}
        editor={editor}
        onToggleSidebar={onToggleSidebar}
        activeFilePath={activeFilePath}
      />
    );
  }

  return (
    <ResizableSidebarLayout
      collapsed={collapsed}
      sidebar={sidebar}
      content={editor}
      onCollapsedChange={handleCollapsedChange}
      defaultWidth={DEFAULT_WIDTH}
      minWidth={MIN_WIDTH}
      maxWidth={MAX_WIDTH}
      expandButtonLabel="Show file tree sidebar"
      expandButtonTitle="Show sidebar"
      expandShortcutKeys={toggleSidebarKeys}
      separatorLabel="Resize file tree sidebar"
    />
  );
}

function MobileEditorLayout({
  collapsed,
  sidebar,
  editor,
  onToggleSidebar,
  activeFilePath,
}: {
  collapsed: boolean;
  sidebar: ReactNode;
  editor: ReactNode;
  onToggleSidebar: () => void;
  activeFilePath: string | null;
}): ReactElement {
  // Once the user opens a file from the tree, slide the drawer shut so the
  // editor is visible — only when the active file actually changes, so toggling
  // the drawer open over an already-open file doesn't immediately re-close it.
  const prevFileRef = useRef(activeFilePath);
  useEffect(() => {
    if (activeFilePath && activeFilePath !== prevFileRef.current && !collapsed) {
      onToggleSidebar();
    }
    prevFileRef.current = activeFilePath;
  }, [activeFilePath, collapsed, onToggleSidebar]);

  return (
    <div className="relative flex h-full w-full overflow-hidden">
      {/* Persistent rail: keeps the open-tree button clear of the editor's tab
          bar (a floating overlay button would cover the first tab). */}
      <div className="flex w-9 shrink-0 justify-center border-r border-border bg-card pt-2">
        <button
          type="button"
          aria-label="Show file tree"
          onClick={onToggleSidebar}
          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
      </div>
      <div className="min-w-0 flex-1 overflow-hidden">{editor}</div>
      <MobileDrawer collapsed={collapsed} onClose={onToggleSidebar} closeLabel="Close file tree">
        {sidebar}
      </MobileDrawer>
    </div>
  );
}

export const EditorSidebarLayout = memo(EditorSidebarLayoutImpl);

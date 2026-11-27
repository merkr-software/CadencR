import { useUiTranslation } from "@/lib/i18n/ui";
import { useCallback, type FocusEvent, type ReactNode, type RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { Sidebar } from "@/components/Sidebar";
import { MobileDrawer } from "@/components/MobileDrawer";
import { SidebarAttentionProvider } from "@/components/SidebarAttentionProvider";
import { SidebarRail } from "@/components/SidebarRail";
import { useIsResizing } from "@/hooks/useIsResizing";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "@/lib/sidebar-width";
import { cn } from "@/lib/utils";

interface AppShellProps {
  isMobile: boolean;
  /** Phone layout on a wide touch screen: the sidebar docked beside the page (`useDockedSidebar`). */
  docked?: boolean;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  onSearch: () => void;
  sidebarPanelRef: RefObject<PanelImperativeHandle | null>;
  leftSidebarRef: RefObject<HTMLDivElement | null>;
  defaultLeftSize: string;
  onLayoutChanged: () => void;
  /** The sidebar panel's resizes; the first after it mounts says it can be driven. */
  onSidebarResize: () => void;
  children: ReactNode;
}

/**
 * The phone layout's drawer and the status-bar sampler, after the main column.
 * A docked sidebar has no drawer, and the bar keeps the page's color.
 */
function PhoneShellChrome({
  collapsed,
  setCollapsed,
  onSearch,
  docked,
}: Pick<AppShellProps, "collapsed" | "setCollapsed" | "onSearch" | "docked">): ReactNode {
  const { t } = useUiTranslation();
  return (
    <>
      {/* Takes the sidebar's color while the drawer is open (`mobile-status-bar.css`). */}
      <div
        aria-hidden
        className="mobile-status-bar"
        data-drawer-open={collapsed || docked ? undefined : ""}
      />
      {!docked && (
        <MobileDrawer
          collapsed={collapsed}
          onClose={() => setCollapsed(true)}
          onOpen={() => setCollapsed(false)}
          closeLabel={t("shell.navigation.closeMenu", "Close menu")}
        >
          <Sidebar onSearch={onSearch} />
        </MobileDrawer>
      )}
    </>
  );
}

/**
 * The phone layout's docked sidebar (a foldable on its side), beside the page
 * at the drawer's width (its touch-sized header and rows are laid out for
 * it). Collapsed, the rail shows in front of it and it stays mounted at zero
 * width, inert, as on the desktop, so expanding it again keeps its scroll and
 * open sections.
 */
function DockedPhoneSidebar({
  collapsed,
  onSearch,
}: {
  collapsed: boolean;
  onSearch: () => void;
}): ReactNode {
  return (
    <div
      data-docked-sidebar
      aria-hidden={collapsed || undefined}
      inert={collapsed || undefined}
      className={cn("h-full shrink-0 overflow-hidden", collapsed ? "w-0" : "w-xs")}
    >
      <div className="h-full w-xs">
        <Sidebar onSearch={onSearch} />
      </div>
    </div>
  );
}

/** The desktop layout's sidebar, inside its resizable panel. */
function DesktopSidebar({
  leftSidebarRef,
  onSearch,
}: Pick<AppShellProps, "leftSidebarRef" | "onSearch">): ReactNode {
  return (
    <div
      ref={leftSidebarRef}
      data-focus-zone="left-sidebar"
      tabIndex={0}
      className="h-full outline-none"
      onFocus={(event) => {
        if (event.target === event.currentTarget && !event.currentTarget.matches(":active")) {
          event.currentTarget.querySelector<HTMLElement>("[data-nav-item]")?.focus();
        }
      }}
    >
      <Sidebar onSearch={onSearch} />
    </div>
  );
}

/** Desktop: focusing the main zone itself hands focus to its first item or the prompt. */
function focusMainContent(event: FocusEvent<HTMLElement>): void {
  if (event.target !== event.currentTarget || event.currentTarget.matches(":active")) return;
  const firstItem = event.currentTarget.querySelector<HTMLElement>("[data-nav-item]");
  const textarea = event.currentTarget.querySelector<HTMLElement>("textarea");
  (firstItem ?? textarea)?.focus();
}

/**
 * The sidebar + main split, one tree for both layouts. The main content sits
 * at the same place in it whatever the layout (shell div → column → panel
 * group → `main` panel → `<main>`), so flipping between the phone and desktop
 * layouts (a rotation, a fold, a window crossing the phone width) never
 * remounts it: open dialogs stay open, the conversation keeps its scroll.
 * Only the sidebar's container changes:
 *
 * - Desktop: a resizable sidebar panel and its handle before the main panel,
 *   plus the collapsed rail before the column.
 * - Phone: the group holds the main panel alone, full-bleed; the sidebar is an
 *   off-canvas drawer after the column (collapsed = closed), so a 390px
 *   viewport isn't eaten by a 200px+ rail.
 * - Phone on a wide touch screen (`docked`, a foldable on its side): the
 *   sidebar before the column, collapsing to the rail as on the desktop.
 *
 * Both drive the same `collapsed`/`setCollapsed` contract from
 * `SidebarContext`, so the topbar's expand button doubles as the drawer
 * trigger. Phone heights flow from `--app-vh` (`app-viewport.css`), which is
 * `dvh` in a browser and accounts for the installed status-bar mode in a PWA;
 * the drawer is positioned `absolute` within the `relative` shell (see
 * `MobileDrawer` for the iOS-standalone rationale).
 */
export function AppShell({
  isMobile,
  docked = false,
  collapsed,
  setCollapsed,
  onSearch,
  sidebarPanelRef,
  leftSidebarRef,
  defaultLeftSize,
  onLayoutChanged,
  onSidebarResize,
  children,
}: AppShellProps): ReactNode {
  // `isDragging` is the global resize flag used only to suspend fluid layout
  // transitions while any handle is active. The sidebar's `collapsible` state
  // deliberately does not depend on it: changing a Panel constraint during the
  // initiating pointerdown makes react-resizable-panels unregister the only
  // mounted Group before that Group can start its own drag.
  const isDragging = useIsResizing();
  const expand = useCallback(() => setCollapsed(false), [setCollapsed]);
  // One attention resolve shared by the sidebar and the collapsed rail: the
  // sidebar stays mounted (at zero width) while the rail shows.
  return (
    <SidebarAttentionProvider>
      <div
        data-app-shell={isMobile ? "phone" : "desktop"}
        className={
          isMobile ? "relative flex h-[var(--app-vh)] w-full overflow-hidden" : "flex h-full w-full"
        }
      >
        {/* The rail: a collapsed desktop sidebar, or a collapsed docked one. */}
        {collapsed && (!isMobile || docked) ? <SidebarRail onExpand={expand} /> : null}
        {isMobile && docked ? (
          <DockedPhoneSidebar collapsed={collapsed} onSearch={onSearch} />
        ) : null}
        <div className="h-full min-w-0 flex-1">
          <ResizablePanelGroup
            data-app-shell-resize={isMobile || isDragging ? undefined : "fluid"}
            orientation="horizontal"
            onLayoutChanged={onLayoutChanged}
          >
            {isMobile ? null : (
              <ResizablePanel
                id="sidebar"
                panelRef={sidebarPanelRef}
                collapsible={collapsed}
                collapsedSize={0}
                defaultSize={defaultLeftSize}
                minSize={`${SIDEBAR_MIN_WIDTH}px`}
                maxSize={`${SIDEBAR_MAX_WIDTH}px`}
                onResize={onSidebarResize}
              >
                <DesktopSidebar leftSidebarRef={leftSidebarRef} onSearch={onSearch} />
              </ResizablePanel>
            )}
            {isMobile ? null : (
              <ResizableHandle
                data-app-shell-handle=""
                className={cn("cursor-col-resize", collapsed && "pointer-events-none opacity-0")}
              />
            )}
            <ResizablePanel id="main">
              <main
                data-focus-zone="main-content"
                tabIndex={isMobile ? undefined : 0}
                className={cn(
                  "h-full overflow-hidden outline-none",
                  isMobile && "w-full min-w-0 pt-[env(safe-area-inset-top)]",
                )}
                onFocus={isMobile ? undefined : focusMainContent}
              >
                {children}
              </main>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
        {isMobile ? (
          <PhoneShellChrome
            collapsed={collapsed}
            setCollapsed={setCollapsed}
            onSearch={onSearch}
            docked={docked}
          />
        ) : null}
      </div>
    </SidebarAttentionProvider>
  );
}

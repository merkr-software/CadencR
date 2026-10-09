import { type ReactNode, type RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { Sidebar } from "@/components/Sidebar";
import { MobileDrawer } from "@/components/MobileDrawer";
import { useIsResizing } from "@/hooks/useIsResizing";
import { cn } from "@/lib/utils";

/**
 * Resize bounds for the global left sidebar, shared with `__root.tsx` so the
 * persisted width can be clamped to the same range on load. The minimum is kept
 * close to DESIGN.md's 268px sidebar width — dragging much narrower leaves the
 * project/feature rows cramped and unreadable.
 */
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 400;
export const SIDEBAR_DEFAULT_WIDTH = 256;

interface AppShellProps {
  isMobile: boolean;
  collapsed: boolean;
  setCollapsed: (collapsed: boolean) => void;
  onSearch: () => void;
  sidebarPanelRef: RefObject<PanelImperativeHandle | null>;
  leftSidebarRef: RefObject<HTMLDivElement | null>;
  defaultLeftSize: string;
  onLayoutChanged: () => void;
  children: ReactNode;
}

function MobileAppShell({
  collapsed,
  setCollapsed,
  onSearch,
  children,
}: Pick<AppShellProps, "collapsed" | "setCollapsed" | "onSearch" | "children">): ReactNode {
  return (
    <div className="relative flex h-[var(--app-vh)] w-full overflow-hidden">
      <main
        data-focus-zone="main-content"
        className="h-full w-full min-w-0 overflow-hidden outline-none pt-[env(safe-area-inset-top)]"
      >
        {children}
      </main>
      <div aria-hidden className="mobile-status-bar" />
      <MobileDrawer
        collapsed={collapsed}
        onClose={() => setCollapsed(true)}
        onOpen={() => setCollapsed(false)}
        closeLabel="Close menu"
      >
        <Sidebar onSearch={onSearch} />
      </MobileDrawer>
    </div>
  );
}

function DesktopAppShell({
  collapsed,
  onSearch,
  sidebarPanelRef,
  leftSidebarRef,
  defaultLeftSize,
  onLayoutChanged,
  children,
  isDragging,
}: Omit<AppShellProps, "isMobile" | "setCollapsed"> & { isDragging: boolean }): ReactNode {
  return (
    <ResizablePanelGroup
      data-app-shell-resize={isDragging ? undefined : "fluid"}
      orientation="horizontal"
      onLayoutChanged={onLayoutChanged}
    >
      <ResizablePanel
        id="sidebar"
        panelRef={sidebarPanelRef}
        collapsible={collapsed}
        collapsedSize={0}
        defaultSize={defaultLeftSize}
        minSize={`${SIDEBAR_MIN_WIDTH}px`}
        maxSize={`${SIDEBAR_MAX_WIDTH}px`}
      >
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
      </ResizablePanel>
      <ResizableHandle
        data-app-shell-handle=""
        className={cn("cursor-col-resize", collapsed && "pointer-events-none opacity-0")}
      />
      <ResizablePanel id="main">
        <main
          data-focus-zone="main-content"
          tabIndex={0}
          className="h-full overflow-hidden outline-none"
          onFocus={(event) => {
            if (event.target !== event.currentTarget || event.currentTarget.matches(":active")) {
              return;
            }
            const firstItem = event.currentTarget.querySelector<HTMLElement>("[data-nav-item]");
            const textarea = event.currentTarget.querySelector<HTMLElement>("textarea");
            (firstItem ?? textarea)?.focus();
          }}
        >
          {children}
        </main>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

/**
 * The sidebar + main split. Desktop renders a resizable two-panel layout;
 * mobile renders the main content full-bleed with the sidebar as an
 * off-canvas drawer (collapsed = closed) so a 390px viewport isn't eaten by a
 * 200px+ rail. Both paths drive the same `collapsed`/`setCollapsed` contract
 * from `SidebarContext`, so the topbar's expand button doubles as the mobile
 * drawer trigger.
 *
 * Mobile heights flow from the `--app-vh` variable (`app-viewport.css`), which is
 * `dvh` in a browser and accounts for the installed status-bar mode in a PWA.
 * The sidebar rides in a `MobileDrawer`, positioned `absolute` within this
 * `relative` shell (see that component for the iOS-standalone rationale).
 */
export function AppShell({
  isMobile,
  collapsed,
  setCollapsed,
  onSearch,
  sidebarPanelRef,
  leftSidebarRef,
  defaultLeftSize,
  onLayoutChanged,
  children,
}: AppShellProps): ReactNode {
  // `isDragging` is the global resize flag used only to suspend fluid layout
  // transitions while any handle is active. The sidebar's `collapsible` state
  // deliberately does not depend on it: changing a Panel constraint during the
  // initiating pointerdown makes react-resizable-panels unregister the only
  // mounted Group before that Group can start its own drag.
  const isDragging = useIsResizing();
  if (isMobile) {
    return (
      <MobileAppShell
        collapsed={collapsed}
        setCollapsed={setCollapsed}
        onSearch={onSearch}
        children={children}
      />
    );
  }

  return (
    <DesktopAppShell
      collapsed={collapsed}
      onSearch={onSearch}
      sidebarPanelRef={sidebarPanelRef}
      leftSidebarRef={leftSidebarRef}
      defaultLeftSize={defaultLeftSize}
      onLayoutChanged={onLayoutChanged}
      children={children}
      isDragging={isDragging}
    />
  );
}

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

/**
 * The sidebar + main split. Desktop renders a resizable two-panel layout;
 * mobile renders the main content full-bleed with the sidebar as an
 * off-canvas drawer (collapsed = closed) so a 390px viewport isn't eaten by a
 * 200px+ rail. Both paths drive the same `collapsed`/`setCollapsed` contract
 * from `SidebarContext`, so the topbar's expand button doubles as the mobile
 * drawer trigger.
 *
 * Mobile heights flow from the `--app-vh` variable (`index.css`), which is
 * `dvh` in a browser but `lvh` in an iOS standalone app — see that file for
 * why. The sidebar rides in a `MobileDrawer`, positioned `absolute` within this
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
  // `collapsible` is what powers the toggle-button collapse (it lets the panel
  // shrink to `collapsedSize={0}` and restores the prior width on expand). But
  // it also makes a *drag* past the minimum snap the panel shut, so the sidebar
  // vanishes when the user keeps dragging inward. Disable it for the duration
  // of a handle drag so resizing hard-clamps to `[minSize, maxSize]`; the
  // toggle button never fires mid-drag, so it keeps working as before.
  const isDragging = useIsResizing();
  if (isMobile) {
    return (
      <div className="relative flex h-[var(--app-vh)] w-full overflow-hidden">
        {/*
         * Only the TOP safe-area inset is reserved shell-wide. Padding the bottom
         * here left a dead background strip under the bottom-pinned prompt/context
         * bar in standalone/fullscreen mode (where the inset is non-zero). Instead,
         * bottom bars that hold tappable controls (the terminal key bar) own their
         * own home-indicator clearance, so the session's bar reaches the edge.
         */}
        <main
          data-focus-zone="main-content"
          className="h-full w-full min-w-0 overflow-hidden outline-none pt-[env(safe-area-inset-top)]"
        >
          {children}
        </main>
        {/*
         * Safe-area insets live INSIDE the sidebar (on its `<aside>`), not as
         * padding here: padding the drawer panel would inset the sidebar's
         * `bg-sidebar` surface from the screen edges, leaving dead gaps at the
         * top/bottom in standalone/fullscreen mode (where the insets are
         * non-zero). Letting the surface reach the edges and padding the content
         * keeps the rail edge-to-edge while clearing the notch/home indicator.
         */}
        <MobileDrawer
          collapsed={collapsed}
          onClose={() => setCollapsed(true)}
          closeLabel="Close menu"
        >
          <Sidebar onSearch={onSearch} />
        </MobileDrawer>
      </div>
    );
  }

  return (
    <ResizablePanelGroup orientation="horizontal" onLayoutChanged={onLayoutChanged}>
      <ResizablePanel
        id="sidebar"
        panelRef={sidebarPanelRef}
        collapsible={!isDragging}
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
          onFocus={(e) => {
            if (e.target === e.currentTarget && !e.currentTarget.matches(":active")) {
              const firstItem = e.currentTarget.querySelector(
                "[data-nav-item]",
              ) as HTMLElement | null;
              if (firstItem) firstItem.focus();
            }
          }}
        >
          <Sidebar onSearch={onSearch} />
        </div>
      </ResizablePanel>
      <ResizableHandle
        className={cn("cursor-col-resize", collapsed && "pointer-events-none opacity-0")}
      />
      <ResizablePanel id="main">
        <main
          data-focus-zone="main-content"
          tabIndex={0}
          className="h-full overflow-hidden outline-none"
          onFocus={(e) => {
            if (e.target === e.currentTarget && !e.currentTarget.matches(":active")) {
              const firstItem = e.currentTarget.querySelector(
                "[data-nav-item]",
              ) as HTMLElement | null;
              if (firstItem) {
                firstItem.focus();
              } else {
                const textarea = e.currentTarget.querySelector("textarea") as HTMLElement | null;
                if (textarea) textarea.focus();
              }
            }
          }}
        >
          {children}
        </main>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

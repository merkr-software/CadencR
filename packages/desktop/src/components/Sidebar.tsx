import { useRef, useState, type ReactElement, type RefObject } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useShortcut } from "@/hooks/useShortcut";
import { Settings, PanelLeftClose } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProjectTree } from "@/components/ProjectTree";
import { AppEnvironmentBadge } from "@/components/AppEnvironmentBadge";
import { CadencrLogo } from "@/components/CadencrLogo";
import { UnifiedAgentsSidebarLink } from "@/components/UnifiedAgentsSidebarLink";
import { ConnectionStatusIndicator } from "@/components/ConnectionStatusIndicator";
import { InternetStatusIndicator } from "@/components/InternetStatusIndicator";
import { SidebarUpdateButton } from "@/components/SidebarUpdateButton";
import { getActiveFocusZone } from "@/lib/focus-zones";
import { APP_VERSION } from "@/lib/app-version";
import { SIDEBAR_FOOTER_PILL_CLASS } from "@/lib/changelog";
import { cn } from "@/lib/utils";
import { useSidebarCollapsed } from "@/components/SidebarContext";
import { getFocusedTabForFeature } from "@/lib/feature-focus-handoff";

export function Sidebar() {
  const { setCollapsed } = useSidebarCollapsed();
  const navigate = useNavigate();
  const sidebarRef = useRef<HTMLElement>(null);
  const [selectedFeatureId, setSelectedFeatureId] = useState<number | null>(null);
  const { activeProjectId, effectiveFeatureId } = useSidebarActiveIds(selectedFeatureId);
  useSidebarKeyboardNavigation(sidebarRef, navigate, effectiveFeatureId);

  return (
    <aside ref={sidebarRef} className="flex h-full flex-col border-r border-border/60 bg-sidebar">
      <SidebarHeader onCollapse={() => setCollapsed(true)} />
      <div className="flex-1 min-w-0 min-h-0 overflow-hidden p-2">
        <div className="mb-2 px-1">
          <UnifiedAgentsSidebarLink />
        </div>
        <ProjectTree
          activeProjectId={activeProjectId}
          activeFeatureId={effectiveFeatureId}
          onSelectFeature={setSelectedFeatureId}
        />
      </div>
      <SidebarFooter />
    </aside>
  );
}

function useSidebarActiveIds(selectedFeatureId: number | null): {
  activeProjectId: number | null;
  effectiveFeatureId: number | null;
} {
  const routerState = useRouterState();
  const routeParams = (routerState.location.pathname.match(
    /\/projects\/(\d+)(?:\/features\/(\d+))?/,
  ) ?? []) as string[];
  const activeProjectId = routeParams[1]
    ? Number(routeParams[1])
    : routerState.location.search?.projectId
      ? Number(routerState.location.search.projectId)
      : null;
  const activeFeatureId = routeParams[2]
    ? Number(routeParams[2])
    : routerState.location.search?.featureId
      ? Number(routerState.location.search.featureId)
      : null;

  return { activeProjectId, effectiveFeatureId: activeFeatureId ?? selectedFeatureId };
}

function useSidebarKeyboardNavigation(
  sidebarRef: RefObject<HTMLElement | null>,
  navigate: ReturnType<typeof useNavigate>,
  activeFeatureId: number | null,
): void {
  const getNavItems = (): HTMLElement[] => {
    if (!sidebarRef.current) return [];
    return Array.from(sidebarRef.current.querySelectorAll("[data-nav-item]")) as HTMLElement[];
  };

  const moveFocus = (direction: "up" | "down"): void => {
    const items = getNavItems();
    if (items.length === 0) return;

    const currentIndex = items.findIndex((el) => el === document.activeElement);
    let nextIndex: number;
    if (currentIndex === -1) {
      nextIndex = direction === "down" ? 0 : items.length - 1;
    } else if (direction === "down") {
      nextIndex = currentIndex >= items.length - 1 ? 0 : currentIndex + 1;
    } else {
      nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
    }
    items[nextIndex].focus({ focusVisible: true } as FocusOptions);
  };

  // CMD+OPT+DOWN: move focus down in the sidebar
  useShortcut("sidebar-focus-down", (e) => {
    if (getActiveFocusZone() !== "left-sidebar") return;
    e.preventDefault();
    moveFocus("down");
  });

  // CMD+OPT+UP: move focus up in the sidebar
  useShortcut("sidebar-focus-up", (e) => {
    if (getActiveFocusZone() !== "left-sidebar") return;
    e.preventDefault();
    moveFocus("up");
  });

  // Enter: navigate to the focused item. `enableOnFormTags: false` so
  // hitting Enter inside the project rename input commits the rename
  // instead of stealing the keystroke for navigation.
  useShortcut(
    "sidebar-activate",
    (e) => {
      if (getActiveFocusZone() !== "left-sidebar") return;
      const focused = document.activeElement as HTMLElement | null;
      if (!focused?.hasAttribute("data-nav-item")) return;
      e.preventDefault();

      const type = focused.getAttribute("data-nav-type");
      const id = focused.getAttribute("data-nav-id");
      const projectId = focused.getAttribute("data-nav-project-id");

      if (type === "feature" && id && projectId) {
        const focusTab = getFocusedTabForFeature(activeFeatureId);
        void navigate({
          to: "/projects/$projectId/features/$featureId",
          params: { projectId, featureId: id },
          search: focusTab ? { focusTab } : undefined,
        });
      } else if (type === "project" && id) {
        // Toggle expand by clicking the project button
        focused.click();
      } else if (type === "agents") {
        void navigate({ to: "/agents" });
      }
    },
    { enableOnFormTags: false, enableOnContentEditable: false },
  );
}

function SidebarHeader({ onCollapse }: { onCollapse: () => void }): ReactElement {
  return (
    <div className="titlebar-drag group relative h-16">
      {/* `pt-3` keeps the logo clear of the macOS traffic-light buttons,
          which sit at ~y=12 inside `titleBarStyle: "hiddenInset"`. */}
      <div className="absolute inset-x-0 bottom-0 top-3 flex items-center justify-center">
        <CadencrLogo className="size-11 mr-2 shrink-0 -translate-y-px" />
        <span
          className="text-2xl font-bold uppercase tracking-widest leading-none"
          style={{ fontFamily: "'Avenir Next', 'Montserrat', 'Helvetica Neue', sans-serif" }}
        >
          Cadencr
        </span>
        <AppEnvironmentBadge
          className="ml-2 self-start mt-2"
          kind={import.meta.env.DEV ? "dev" : "beta"}
        />
      </div>
      <div className="absolute right-4 inset-y-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="Collapse sidebar (⌘B)"
          onClick={onCollapse}
        >
          <PanelLeftClose className="size-4" />
          <span className="sr-only">Collapse sidebar</span>
        </Button>
      </div>
    </div>
  );
}

function SidebarFooter(): ReactElement {
  return (
    <div className="flex flex-col items-center gap-1 py-2">
      <SidebarUpdateButton />
      <div className={cn(SIDEBAR_FOOTER_PILL_CLASS, "text-foreground/80")}>
        <Link
          to="/settings"
          data-nav-item
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-full",
            "focus-visible:outline-none focus-visible:text-foreground",
          )}
        >
          <Settings className="size-4 shrink-0" />
          <span>Settings</span>
        </Link>
        <span className="flex shrink-0 items-center gap-1.5 text-[10px] text-muted-foreground tabular-nums">
          <InternetStatusIndicator />
          <span>v{APP_VERSION}</span>
        </span>
      </div>
      {/* Hidden when healthy; renders a status pill + popover otherwise. */}
      <ConnectionStatusIndicator />
    </div>
  );
}

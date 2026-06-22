import { useEffect, useRef, useState, type ReactElement, type RefObject } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useShortcut } from "@/hooks/useShortcut";
import { Settings, PanelLeftClose, Search, Maximize, Minimize, Share } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { KbdShortcut } from "@/components/KbdShortcut";
import { ProjectTree } from "@/components/ProjectTree";
import { SidebarPinnedConversations } from "@/components/SidebarPinnedConversations";
import { AppEnvironmentBadge } from "@/components/AppEnvironmentBadge";
import { CadencrLogo } from "@/components/CadencrLogo";
import { UnifiedAgentsSidebarLink } from "@/components/UnifiedAgentsSidebarLink";
import { ConnectionStatusIndicator } from "@/components/ConnectionStatusIndicator";
import { InternetStatusIndicator } from "@/components/InternetStatusIndicator";
import { SidebarUpdateButton } from "@/components/SidebarUpdateButton";
import { SidebarPushButton } from "@/components/SidebarPushButton";
import { RemoteAccessButton } from "@/components/remote/RemoteAccessButton";
import { getActiveFocusZone } from "@/lib/focus-zones";
import { APP_VERSION } from "@/lib/app-version";
import { SIDEBAR_FOOTER_PILL_CLASS } from "@/lib/changelog";
import { cn } from "@/lib/utils";
import { useSidebarCollapsed } from "@/components/SidebarContext";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useFullscreen } from "@/hooks/useFullscreen";
import { getFocusedTabForFeature } from "@/lib/feature-focus-handoff";

export function Sidebar({ onSearch }: { onSearch: () => void }) {
  const { setCollapsed } = useSidebarCollapsed();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const sidebarRef = useRef<HTMLElement>(null);
  const [selectedFeatureId, setSelectedFeatureId] = useState<number | null>(null);
  const { activeProjectId, effectiveFeatureId } = useSidebarActiveIds(selectedFeatureId);
  useSidebarKeyboardNavigation(sidebarRef, navigate, effectiveFeatureId);

  return (
    <aside
      ref={sidebarRef}
      className="glass-surface flex h-full flex-col border-r border-border/60 bg-sidebar"
    >
      <SidebarHeader onCollapse={() => setCollapsed(true)} />
      {/* Flex column so the tree gets the *remaining* height (not 100%, which
          overflows past the search bar and clips the scroll area's bottom). */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-2">
        <div className="mb-2 shrink-0 px-1">
          <SidebarSearchButton onSearch={onSearch} />
        </div>
        {/* The unified agents grid is desktop-only — hide its entry on phones. */}
        {!isMobile && (
          <div className="mb-2 shrink-0 px-1">
            <UnifiedAgentsSidebarLink />
          </div>
        )}
        <SidebarPinnedConversations
          activeFeatureId={effectiveFeatureId}
          onSelectFeature={setSelectedFeatureId}
        />
        <div className="min-h-0 flex-1">
          <ProjectTree
            activeProjectId={activeProjectId}
            activeFeatureId={effectiveFeatureId}
            onSelectFeature={setSelectedFeatureId}
          />
        </div>
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

function SidebarSearchButton({ onSearch }: { onSearch: () => void }): ReactElement {
  const terminalFocused = useIsTerminalFocusActive();
  const title = terminalFocused ? "Search unavailable while terminal is focused" : "Search (⌘K)";
  return (
    <button
      type="button"
      onClick={onSearch}
      title={title}
      className={cn(
        "flex w-full items-center gap-2 rounded-md border border-border/60 bg-background/40 px-2 py-1.5",
        "text-sm text-muted-foreground outline-none transition-colors",
        "hover:bg-accent/50 hover:text-foreground focus-visible:bg-accent focus-visible:outline-none",
      )}
    >
      <Search className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left">Search</span>
      {terminalFocused ? (
        <InactiveShortcutHint />
      ) : (
        <KbdShortcut keys={["cmd", "K"]} variant="hint" />
      )}
    </button>
  );
}

function useIsTerminalFocusActive(): boolean {
  const [activeFocusZone, setActiveFocusZone] = useState<string | null>(() => getActiveFocusZone());

  useEffect(() => {
    let timeoutId = 0;
    const refresh = (): void => setActiveFocusZone(getActiveFocusZone());
    const refreshAfterFocusSettles = (): void => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(refresh, 0);
    };

    window.addEventListener("focusin", refresh, true);
    window.addEventListener("focusout", refreshAfterFocusSettles, true);
    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener("focusin", refresh, true);
      window.removeEventListener("focusout", refreshAfterFocusSettles, true);
    };
  }, []);

  return activeFocusZone === "terminal";
}

function InactiveShortcutHint(): ReactElement {
  return (
    <kbd className="inline-flex items-center justify-center gap-px rounded border border-current/25 bg-transparent px-1 py-0.5 text-[10px] font-mono font-medium leading-none text-current opacity-50">
      <span className="leading-none">--</span>
    </kbd>
  );
}

function SidebarHeader({ onCollapse }: { onCollapse: () => void }): ReactElement {
  return (
    <div className="titlebar-drag group relative h-16">
      {/* `pt-3` keeps the logo clear of the macOS traffic-light buttons,
          which sit at ~y=12 inside `titleBarStyle: "hiddenInset"`. */}
      <div className="absolute inset-x-0 bottom-0 top-3 flex items-center justify-center">
        <CadencrLogo className="size-11 mr-2 shrink-0 -translate-y-px" />
        <span className="font-brand text-2xl font-extrabold uppercase tracking-widest leading-none">
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

function SidebarFullscreenButton(): ReactElement | null {
  const isMobile = useIsMobile();
  const { supported, isFullscreen, isStandalone, toggle } = useFullscreen();
  // Phones only, and not when already chromeless (installed / Add-to-Home-Screen).
  if (!isMobile || isStandalone) return null;
  // Where the Fullscreen API exists (Android Chrome) the button toggles it.
  if (supported) {
    return (
      <button
        type="button"
        data-nav-item
        onClick={toggle}
        className={cn(SIDEBAR_FOOTER_PILL_CLASS, "text-foreground/80")}
        title={isFullscreen ? "Exit full screen" : "Full screen"}
      >
        <span className="flex items-center gap-2">
          {isFullscreen ? (
            <Minimize className="size-4 shrink-0" />
          ) : (
            <Maximize className="size-4 shrink-0" />
          )}
          <span>{isFullscreen ? "Exit full screen" : "Full screen"}</span>
        </span>
      </button>
    );
  }
  // iOS exposes no Fullscreen API. The only chromeless path is an installed
  // Home-Screen web app, which web JS can neither trigger nor reach (the
  // "Add to Home Screen" action lives in the browser's own toolbar Share menu,
  // not the Web Share sheet). So we show clear, readable instructions instead.
  return <AddToHomeScreenDialog />;
}

function AddToHomeScreenDialog(): ReactElement {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          data-nav-item
          className={cn(SIDEBAR_FOOTER_PILL_CLASS, "text-foreground/80")}
          title="Full screen"
        >
          <span className="flex items-center gap-2">
            <Maximize className="size-4 shrink-0" />
            <span>Full screen</span>
          </span>
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to Home Screen</DialogTitle>
          <DialogDescription>
            iPhone browsers can’t go full screen from a web page. Add Cadencr to your Home Screen to
            run it full screen, like an app.
          </DialogDescription>
        </DialogHeader>
        <ol className="space-y-3 text-sm">
          <li className="flex items-center gap-2">
            <span className="font-medium text-foreground">1.</span>
            <span>
              Tap the <Share className="inline size-4 -translate-y-px" aria-label="Share" /> Share
              button in your browser’s toolbar.
            </span>
          </li>
          <li className="flex items-center gap-2">
            <span className="font-medium text-foreground">2.</span>
            <span>
              Scroll down and choose{" "}
              <span className="font-medium text-foreground">Add to Home Screen</span>.
            </span>
          </li>
          <li className="flex items-center gap-2">
            <span className="font-medium text-foreground">3.</span>
            <span>
              Open <span className="font-medium text-foreground">Cadencr</span> from the new icon —
              it opens full screen.
            </span>
          </li>
        </ol>
        <p className="text-xs text-muted-foreground">
          The first time you open it from the Home Screen, you’ll pair this device once more.
        </p>
      </DialogContent>
    </Dialog>
  );
}

function SidebarFooter(): ReactElement {
  return (
    <div className="flex flex-col items-center gap-1 py-2">
      <SidebarFullscreenButton />
      <SidebarPushButton />
      <SidebarUpdateButton />
      <div className="flex w-[90%] items-center gap-1.5">
        <Link
          to="/settings"
          data-nav-item
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-pill)] border border-transparent px-3 py-1.5 text-xs text-foreground/80 transition-colors",
            "hover:border-border hover:bg-accent hover:text-foreground",
            "focus-visible:border-border focus-visible:bg-accent focus-visible:outline-none focus-visible:text-foreground",
          )}
        >
          <Settings className="size-4 shrink-0" />
          <span>Settings</span>
        </Link>
        <RemoteAccessButton />
        <span className="flex shrink-0 items-center gap-1.5 px-1 text-[10px] text-muted-foreground tabular-nums">
          <InternetStatusIndicator />
          <span>v{APP_VERSION}</span>
        </span>
      </div>
      {/* Hidden when healthy; renders a status pill + popover otherwise. */}
      <ConnectionStatusIndicator />
    </div>
  );
}

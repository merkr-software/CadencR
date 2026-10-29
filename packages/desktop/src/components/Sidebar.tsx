import { useEffect, useRef, useState, type ReactElement } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
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
import { KbdShortcut, ResolvedShortcutHint } from "@/components/KbdShortcut";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarRowActionsProvider } from "@/components/SidebarRowActionsProvider";
import { ShortcutHintsProvider } from "@/hooks/useNavShortcutHints";
import { SidebarConfigProvider } from "@/components/SidebarConfigProvider";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import {
  SidebarAttentionShortcuts,
  SidebarRenameDialog,
  useSidebarRowShortcuts,
} from "@/components/SidebarShortcuts";
import { handleSidebarTypeToFilter, SidebarFilterInput } from "@/components/SidebarFilterInput";
import { AppEnvironmentBadge } from "@/components/AppEnvironmentBadge";
import { CadencrLogo } from "@/components/CadencrLogo";
import { MarketplaceSidebarLink } from "@/components/MarketplaceSidebarLink";
import { SchedulesSidebarLink } from "@/components/SchedulesSidebarLink";
import { UnifiedAgentsSidebarLink } from "@/components/UnifiedAgentsSidebarLink";
import { ConnectionStatusIndicator } from "@/components/ConnectionStatusIndicator";
import { InternetStatusIndicator } from "@/components/InternetStatusIndicator";
import { SidebarUpdateButton } from "@/components/SidebarUpdateButton";
import { SidebarPushButton } from "@/components/SidebarPushButton";
import { RemoteAccessButton } from "@/components/remote/RemoteAccessButton";
import { StorageMaintenanceProgress } from "@/components/StorageMaintenanceProgress";
import { APP_ENVIRONMENT } from "@/lib/app-environment";
import { getActiveFocusZone } from "@/lib/focus-zones";
import { APP_VERSION } from "@/lib/app-version";
import { SIDEBAR_FOOTER_PILL_CLASS } from "@/lib/changelog";
import { cn } from "@/lib/utils";
import { useSidebarCollapsed } from "@/components/SidebarContext";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useRouteFeatureIds } from "@/hooks/useRouteFeatureIds";
import { useFullscreen } from "@/hooks/useFullscreen";
import { useSidebarKeyboardNavigation } from "@/hooks/useSidebarKeyboardNavigation";
import { useBrowserActivityBridge } from "@/hooks/useFeatureActivityCounts";
import { useToastAnchor } from "@/hooks/useToastAnchor";
import {
  useSidebarDisplayAttributes,
  useSidebarHighlightAttribute,
} from "@/hooks/useSidebarDisplayAttributes";
import { SidebarSampleBanner } from "@/components/SidebarSampleBanner";
import { SidebarSections } from "@/components/SidebarSections";
import { SidebarSampleProvider } from "@/components/SidebarSampleProvider";
import { SidebarDisplayOptionsHost } from "@/components/SidebarDisplayOptionsPopover";
import { useSidebarShowsSamples } from "@/stores/sidebar-preview-store";
import { HAS_MAC_WINDOW_CONTROLS } from "@/lib/mac-window-controls";
import { useShortcutLabel } from "@/hooks/useShortcutLabel";

export function Sidebar({ onSearch }: { onSearch: () => void }) {
  const { collapsed, setCollapsed } = useSidebarCollapsed();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const sidebarRef = useRef<HTMLElement>(null);
  const [selectedFeatureId, setSelectedFeatureId] = useState<number | null>(null);
  const { activeProjectId, effectiveFeatureId } = useSidebarActiveIds(selectedFeatureId);
  useSidebarKeyboardNavigation(sidebarRef, navigate, effectiveFeatureId);
  useSidebarRowShortcuts();
  useBrowserActivityBridge();
  const displayAttributes = useSidebarDisplayAttributes();
  useSidebarHighlightAttribute(sidebarRef);
  const typeToFilter = useSidebarOption("typeToFilter");
  const showsSamples = useSidebarShowsSamples();

  return (
    <SidebarConfigProvider>
      <ShortcutHintsProvider enabled={!collapsed}>
        <aside
          data-app-sidebar
          {...displayAttributes}
          ref={sidebarRef}
          onKeyDown={typeToFilter ? handleSidebarTypeToFilter : undefined}
          aria-hidden={!isMobile && collapsed ? true : undefined}
          inert={!isMobile && collapsed ? true : undefined}
          // Safe-area insets pad the content here (not the mobile drawer wrapper) so
          // `bg-sidebar` reaches the screen edges while the header/footer clear the
          // notch and home indicator. The `env()` values are 0 on desktop, so this
          // is a no-op outside fullscreen/standalone mobile.
          className={cn(
            "glass-surface flex h-full flex-col border-r border-border/60 bg-sidebar pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]",
            !isMobile && "transition-[opacity,transform] duration-[220ms] ease-[var(--ease-fluid)]",
            !isMobile && collapsed && "pointer-events-none -translate-x-2 opacity-0",
          )}
        >
          <SidebarHeader onCollapse={() => setCollapsed(true)} />
          {/* Flex column so the scroller gets the *remaining* height (not 100%, which
          overflows past the search bar and clips the scroll area's bottom). */}
          <SidebarDisplayOptionsHost collapsed={!isMobile && collapsed}>
            <SidebarSampleProvider enabled={showsSamples}>
              <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-2">
                <div className="mb-2 shrink-0 px-1">
                  <SidebarSearchButton onSearch={onSearch} />
                </div>
                {/* The unified agents grid is desktop-only — hide its entry on phones.
            Schedules is a plain list, so it works everywhere. */}
                <div className="mb-2 flex shrink-0 flex-col gap-0.5 px-1">
                  <MarketplaceSidebarLink />
                  {!isMobile && <UnifiedAgentsSidebarLink />}
                  <SchedulesSidebarLink />
                </div>
                <SidebarSampleBanner />
                {!showsSamples && <SidebarFilterInput />}
                <SidebarAttentionShortcuts
                  activeFeatureId={effectiveFeatureId}
                  onSelectFeature={setSelectedFeatureId}
                />
                <SidebarRowActionsProvider>
                  {/* One scroller for the blocks and the projects, so every block stays
                reachable however many are open, on a phone as on desktop. */}
                  <ScrollArea data-sidebar-scroll className="min-h-0 min-w-0 flex-1">
                    <div className="flex min-w-0 flex-col pb-2">
                      <SidebarSections
                        showsSamples={showsSamples}
                        activeProjectId={activeProjectId}
                        activeFeatureId={effectiveFeatureId}
                        onSelectFeature={setSelectedFeatureId}
                      />
                    </div>
                  </ScrollArea>
                </SidebarRowActionsProvider>
              </div>
            </SidebarSampleProvider>
          </SidebarDisplayOptionsHost>
          <SidebarFooter anchorsToasts={!isMobile && !collapsed} />
          <SidebarRenameDialog />
        </aside>
      </ShortcutHintsProvider>
    </SidebarConfigProvider>
  );
}

function useSidebarActiveIds(selectedFeatureId: number | null): {
  activeProjectId: number | null;
  effectiveFeatureId: number | null;
} {
  const { projectId, featureId } = useRouteFeatureIds();
  return { activeProjectId: projectId, effectiveFeatureId: featureId ?? selectedFeatureId };
}

function SidebarSearchButton({ onSearch }: { onSearch: () => void }): ReactElement {
  const terminalFocused = useIsTerminalFocusActive();
  const searchCombo = useShortcutLabel("command-palette");
  const title = terminalFocused
    ? "Search unavailable while terminal is focused"
    : `Search (${searchCombo})`;
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
        <ResolvedShortcutHint shortcutId="command-palette" />
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
    <span aria-hidden="true" className="shrink-0">
      <KbdShortcut keys={[]} variant="hint" disabled />
    </span>
  );
}

function SidebarHeader({ onCollapse }: { onCollapse: () => void }): ReactElement {
  const toggleSidebarCombo = useShortcutLabel("toggle-sidebar");
  // Reserve a dedicated strip for the macOS traffic-light buttons (they sit
  // at ~y=12 inside `titleBarStyle: "hiddenInset"`) so the lockup below can
  // never overlap them. Browsers and other platforms have no window controls
  // here, so they skip the strip.
  return (
    <div
      className={cn("titlebar-drag group flex flex-col", HAS_MAC_WINDOW_CONTROLS ? "h-18" : "h-16")}
    >
      {HAS_MAC_WINDOW_CONTROLS && <div className="h-8 shrink-0" />}
      <div className="relative flex flex-1 items-center justify-center">
        <CadencrLogo className="mr-2 size-9 shrink-0 -translate-y-px" />
        <span className="font-brand text-xl font-extrabold uppercase tracking-widest leading-none">
          Cadencr
        </span>
        <AppEnvironmentBadge className="ml-2 -translate-y-2" environment={APP_ENVIRONMENT} />
        <div className="absolute right-4 inset-y-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title={`Collapse sidebar (${toggleSidebarCombo})`}
            onClick={onCollapse}
          >
            <PanelLeftClose className="size-4" />
            <span className="sr-only">Collapse sidebar</span>
          </Button>
        </div>
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

function SidebarFooter({ anchorsToasts }: { anchorsToasts: boolean }): ReactElement {
  const settingsRowRef = useRef<HTMLDivElement>(null);
  useToastAnchor(settingsRowRef, anchorsToasts);
  return (
    <div className="flex flex-col items-center gap-1 py-2">
      <SidebarFullscreenButton />
      <SidebarPushButton />
      <SidebarUpdateButton />
      <StorageMaintenanceProgress />
      <div ref={settingsRowRef} className="flex w-[90%] items-center gap-1.5">
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

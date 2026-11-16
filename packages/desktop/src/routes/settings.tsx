import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ChevronLeft } from "lucide-react";
import { useShortcut } from "@/hooks/useShortcut";
import { useIsMobile } from "@/hooks/useIsMobile";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SidebarCollapsedChrome } from "@/components/SidebarCollapsedChrome";
import { useSidebarCollapsed } from "@/components/SidebarContext";
import { SettingsNavSidebar } from "@/components/settings/SettingsNavSidebar";
import { SettingsPageContent } from "@/components/settings/SettingsPageContent";
import {
  DEFAULT_SETTINGS_PAGE,
  resolveSettingsTarget,
  settingsPageMeta,
} from "@/components/settings/settings-catalog";
import { showSettingsTarget } from "@/components/settings/reveal-settings-anchor";
import {
  availableSettingsGroups,
  currentSettingsPlatform,
} from "@/components/settings/settings-availability";
import {
  isLegacyMarketplaceLink,
  parseSettingsSearch,
} from "@/components/settings/settings-navigation";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
  validateSearch: parseSettingsSearch,
  beforeLoad: ({ search }) => {
    if (isLegacyMarketplaceLink(search)) throw redirect({ to: "/marketplace" });
  },
});

/**
 * One settings page at a time, picked from the rail or by `?section=`: a page
 * id, a retired section's id, or the anchor of one setting (scrolled to and
 * briefly outlined). With no section, desktop opens General and phones show
 * the list of pages.
 */
function SettingsPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const mainRef = useRef<HTMLElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const queryRef = useRef(query);
  queryRef.current = query;

  const target = resolveSettingsTarget(search.section);
  const pageId = target?.page.id ?? DEFAULT_SETTINGS_PAGE;
  const showIndex = isMobile && !target;
  // Phones show the rail only as the index; on a page its search is hidden.
  const railShown = !isMobile || showIndex;
  const railShownRef = useRef(railShown);
  railShownRef.current = railShown;
  const groups = useMemo(
    () => availableSettingsGroups(currentSettingsPlatform(isMobile)),
    [isMobile],
  );
  const wide = settingsPageMeta(pageId).wide === true;

  const goBack = useCallback(() => void navigate({ to: "/" }), [navigate]);

  // Escape first clears a visible search, then leaves Settings — including
  // from inside form controls, as it always has.
  useShortcut("settings-back", (e) => {
    e.preventDefault();
    if (queryRef.current && railShownRef.current) setQuery("");
    else goBack();
  });
  useShortcut("settings-search", (e) => {
    const input = searchRef.current;
    // A hidden field can't take focus; leave the keystroke alone.
    if (!input || !railShownRef.current) return;
    e.preventDefault();
    input.focus();
    input.select();
  });

  // A new page starts at its top; a setting's anchor is scrolled to instead.
  const anchor = target?.anchor ?? null;
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    if (main) showSettingsTarget(main, anchor);
  }, [pageId, anchor]);

  const openSection = useCallback(
    (section: string) => {
      // Picking what is already shown changes no dependency of the effect
      // above, so show it again here: back to the page's top, or the anchor
      // outlined once more.
      const next = resolveSettingsTarget(section);
      const main = mainRef.current;
      if (main && next?.page.id === pageId && next.anchor === anchor) {
        showSettingsTarget(main, anchor);
      }
      void navigate({ to: "/settings", search: { section } });
    },
    [navigate, pageId, anchor],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <SettingsPageHeader onBack={goBack} />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <SettingsNavSidebar
          variant={showIndex ? "index" : "rail"}
          activePageId={showIndex ? null : pageId}
          query={query}
          onQueryChange={setQuery}
          onNavigate={openSection}
          searchRef={searchRef}
          groups={groups}
        />
        {showIndex ? null : (
          <main ref={mainRef} className="relative min-w-0 flex-1 overflow-y-auto">
            <div
              key={pageId}
              className={cn(
                "mx-auto px-4 pt-4 pb-20 animate-in fade-in-0 duration-200 ease-out md:px-10 md:pt-10",
                wide ? "max-w-[1120px]" : "max-w-[800px]",
              )}
            >
              {isMobile ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-2 mb-3 h-8 gap-1 px-2 text-muted-foreground"
                  onClick={() => void navigate({ to: "/settings", search: {} })}
                >
                  <ChevronLeft aria-hidden className="size-4" />
                  All settings
                </Button>
              ) : null}
              <SettingsPageContent pageId={pageId} />
            </div>
          </main>
        )}
      </div>
    </div>
  );
}

function SettingsPageHeader({ onBack }: { onBack: () => void }): React.JSX.Element {
  const { collapsed, setCollapsed } = useSidebarCollapsed();
  return (
    <header className="titlebar-drag flex min-h-11 shrink-0 items-center gap-3 border-b border-border px-4 md:px-6">
      <SidebarCollapsedChrome visible={collapsed} onExpand={() => setCollapsed(false)} />
      <h1 className="min-w-0 flex-1 text-sm font-semibold">Settings</h1>
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        title="Back to workspace (Esc)"
        aria-label="Back to workspace"
        className="h-7 shrink-0 gap-1.5 px-2"
      >
        <ArrowLeft aria-hidden="true" className="size-3.5" />
        <span className="hidden sm:inline">Back</span>
      </Button>
    </header>
  );
}

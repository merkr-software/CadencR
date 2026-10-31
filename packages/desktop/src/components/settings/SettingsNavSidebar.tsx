import { memo, useMemo, useRef, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ChevronRight, Search, X } from "lucide-react";
import { ResolvedKbdChord } from "@/components/KbdShortcut";
import { HighlightedText } from "@/components/command-palette/PaletteText";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  SETTINGS_NAV_GROUPS,
  type SettingsNavGroup,
  type SettingsPageId,
} from "./settings-catalog";
import { firstSearchTarget, highlightRanges, searchSettings } from "./settings-search";

/**
 * The settings rail: a search field over every page and setting, then the
 * pages grouped by what they configure. On phones the same list is the
 * settings index (`variant="index"`), full width, before a page is picked.
 *
 * Picking a page or a result calls `onNavigate` with a `?section=` value: a
 * page id, or the anchor of the setting a result points at.
 */
function SettingsNavSidebarImpl({
  activePageId,
  query,
  onQueryChange,
  onNavigate,
  searchRef,
  variant = "rail",
  groups = SETTINGS_NAV_GROUPS,
}: {
  activePageId: SettingsPageId | null;
  query: string;
  onQueryChange: (query: string) => void;
  onNavigate: (section: string) => void;
  searchRef?: RefObject<HTMLInputElement | null>;
  variant?: "rail" | "index";
  groups?: readonly SettingsNavGroup[];
}): React.JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null);
  const ownSearchRef = useRef<HTMLInputElement | null>(null);
  const inputRef = searchRef ?? ownSearchRef;
  const results = useMemo(() => searchSettings(query, groups), [query, groups]);
  const searching = query.trim().length > 0;

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // Enter that confirms an IME composition (Japanese, Chinese…) isn't a pick.
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      const target = firstSearchTarget(results);
      if (target) onNavigate(target);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      listRef.current?.querySelector<HTMLElement>("[data-settings-nav-item]")?.focus();
    }
  };

  return (
    <aside
      aria-label="Settings sections"
      className={cn(
        "flex min-h-0 flex-col",
        variant === "rail"
          ? "hidden w-60 shrink-0 border-r border-border bg-[var(--sidebar)] md:flex"
          : "w-full flex-1",
      )}
    >
      <div className={cn("shrink-0", variant === "rail" ? "px-3 pt-3 pb-2" : "px-4 pt-4 pb-2")}>
        <SettingsSearchField
          inputRef={inputRef}
          query={query}
          onQueryChange={onQueryChange}
          onKeyDown={onSearchKeyDown}
        />
      </div>
      <nav
        ref={listRef}
        aria-label={searching ? "Search results" : "Settings pages"}
        onKeyDown={(event) => moveFocus(event, listRef.current, inputRef.current)}
        className={cn("min-h-0 flex-1 overflow-y-auto pb-4", variant === "rail" ? "px-2" : "px-3")}
      >
        {searching ? (
          <SearchResults results={results} query={query} onNavigate={onNavigate} />
        ) : (
          groups.map((group) => (
            <NavGroup key={group.label} label={group.label}>
              {group.pages.map((page) => (
                <NavItem
                  key={page.id}
                  icon={page.icon}
                  active={page.id === activePageId}
                  onClick={() => onNavigate(page.id)}
                  trailing={variant === "index" ? <ChevronRight aria-hidden /> : null}
                >
                  {page.label}
                </NavItem>
              ))}
            </NavGroup>
          ))
        )}
      </nav>
    </aside>
  );
}

export const SettingsNavSidebar = memo(SettingsNavSidebarImpl);

function SettingsSearchField({
  inputRef,
  query,
  onQueryChange,
  onKeyDown,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (query: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}): React.JSX.Element {
  return (
    <div className="relative flex h-8 items-center rounded-md border border-border bg-background/60 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30">
      <Search aria-hidden className="pointer-events-none ml-2.5 size-3.5 text-muted-foreground" />
      <Input
        ref={inputRef}
        variant="ghost"
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search settings"
        aria-label="Search settings"
        autoComplete="off"
        spellCheck={false}
        className="h-full flex-1 px-2 text-[13px] [&::-webkit-search-cancel-button]:hidden"
      />
      {query ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Clear search"
          onClick={() => {
            onQueryChange("");
            inputRef.current?.focus();
          }}
          className="mr-1 text-muted-foreground"
        >
          <X />
        </Button>
      ) : (
        <span className="pointer-events-none mr-2 hidden text-muted-foreground md:inline-flex">
          <ResolvedKbdChord shortcutId="settings-search" />
        </span>
      )}
    </div>
  );
}

function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="pt-3 first:pt-1">
      <div className="px-2.5 pb-1 text-[11px] font-medium text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function NavItem({
  icon,
  active = false,
  onClick,
  trailing,
  children,
}: {
  icon: ReactNode;
  active?: boolean;
  onClick: () => void;
  trailing?: ReactNode;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-settings-nav-item=""
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex min-h-8 w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring/50 max-md:min-h-11",
        active
          ? "bg-accent font-medium text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <span
        className={cn(
          "grid size-4 shrink-0 place-items-center",
          active ? "text-primary" : "text-muted-foreground",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing ? (
        <span className="shrink-0 text-muted-foreground [&_svg]:size-4">{trailing}</span>
      ) : null}
    </button>
  );
}

function SearchResults({
  results,
  query,
  onNavigate,
}: {
  results: ReturnType<typeof searchSettings>;
  query: string;
  onNavigate: (section: string) => void;
}): React.JSX.Element {
  if (results.length === 0) {
    return (
      <div role="status" className="px-2.5 py-6 text-xs leading-relaxed text-muted-foreground">
        <p className="font-medium text-foreground">No settings match “{query.trim()}”.</p>
        <p className="mt-1">Try a page name, or a word like “vim”, “theme” or “token”.</p>
      </div>
    );
  }
  return (
    <>
      {results.map((group) => (
        <NavGroup key={group.label} label={group.label}>
          {group.pages.map(({ page, entries }) => (
            <div key={page.id}>
              <NavItem icon={page.icon} onClick={() => onNavigate(page.id)}>
                <Highlighted text={page.label} query={query} />
              </NavItem>
              {entries.map((entry) => (
                <button
                  key={entry.label}
                  type="button"
                  data-settings-nav-item=""
                  onClick={() => onNavigate(entry.anchor ?? page.id)}
                  className="flex min-h-7 w-full items-center rounded-md py-1 pr-2.5 pl-9 text-left text-xs text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 max-md:min-h-10"
                >
                  <span className="truncate">
                    <Highlighted text={entry.label} query={query} />
                  </span>
                </button>
              ))}
            </div>
          ))}
        </NavGroup>
      ))}
    </>
  );
}

function Highlighted({ text, query }: { text: string; query: string }): ReactNode {
  return <HighlightedText text={text} ranges={highlightRanges(text, query)} />;
}

/** Arrow keys walk the rail's buttons; Up from the first returns to the search field. */
function moveFocus(
  event: KeyboardEvent<HTMLElement>,
  list: HTMLElement | null,
  search: HTMLInputElement | null,
): void {
  if (!list || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
  const items = [...list.querySelectorAll<HTMLElement>("[data-settings-nav-item]")];
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (index === -1) return;
  event.preventDefault();
  const next = event.key === "ArrowDown" ? items[index + 1] : items[index - 1];
  if (next) next.focus();
  else if (event.key === "ArrowUp") search?.focus();
}

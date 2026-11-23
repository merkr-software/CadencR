import { browserTabLabel } from "./browser-tab-label";
import { useUiTranslation } from "@/lib/i18n/ui";
import {
  useCallback,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { CheckIcon, ChevronsUpDownIcon, RotateCcwIcon, SearchIcon, XIcon } from "lucide-react";

import { KBD_HINT_PROPS, ResolvedShortcutHint } from "@/components/KbdShortcut";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  useFilteredVirtualList,
  type FilteredVirtualListRowContext,
} from "@/hooks/useFilteredVirtualList";
import type { BrowserTabMetadata } from "@/lib/desktop-bridge";
import { cn } from "@/lib/utils";
import { BrowserPageIcon } from "./BrowserTabIcons";

const ROW_HEIGHT = 36;
const LIST_HEIGHT = 288;

export function BrowserTabOverflow({
  tabs,
  activeTabId,
  onActivate,
  onClose,
  onReopen,
  busy,
  onOpenChange,
}: {
  tabs: BrowserTabMetadata[];
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onReopen: () => void;
  busy: boolean;
  onOpenChange?: (open: boolean) => void;
}): ReactElement {
  const { t } = useUiTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const changeOpen = useCallback(
    (next: boolean): void => {
      setOpen(next);
      if (!next) setQuery("");
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const pick = useCallback(
    (tab: BrowserTabMetadata): void => {
      onActivate(tab.id);
      changeOpen(false);
    },
    [changeOpen, onActivate],
  );
  const renderRow = useCallback(
    (context: FilteredVirtualListRowContext<BrowserTabMetadata>) => (
      <OverflowRow
        {...context}
        id={`${listId}-option-${context.index}`}
        active={context.item.id === activeTabId}
        onClose={onClose}
      />
    ),
    [activeTabId, listId, onClose],
  );
  const tabSearchLabel = useCallback(
    (tab: BrowserTabMetadata) => `${browserTabLabel(tab, t)} ${tab.url}`,
    [t],
  );
  const { list, onKeyDown, filteredCount, activeIndex } =
    useFilteredVirtualList<BrowserTabMetadata>({
      items: tabs,
      query,
      getLabel: tabSearchLabel,
      onPick: pick,
      renderRow,
      height: LIST_HEIGHT,
      rowHeight: ROW_HEIGHT,
      emptyState: (
        <p className="py-6 text-center text-xs text-muted-foreground">
          {t("workspace.tools.browserTabOverflow.noTabsFound", "No tabs found")}
        </p>
      ),
    });
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <OverflowTrigger count={tabs.length} />
      <PopoverContent
        align="end"
        className="w-80 p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <OverflowPanel
          inputRef={inputRef}
          listId={listId}
          query={query}
          filteredCount={filteredCount}
          activeIndex={activeIndex}
          list={list}
          busy={busy}
          onQueryChange={setQuery}
          onKeyDown={onKeyDown}
          onReopen={() => {
            changeOpen(false);
            onReopen();
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function OverflowTrigger({ count }: { count: number }): ReactElement {
  const { t } = useUiTranslation();
  return (
    <PopoverTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="h-7 shrink-0"
        aria-label={t("workspace.tools.browserTabOverflow.searchAllCount", {
          count: count,
          defaultValue_one: "Search all {{count}} browser tabs",
          defaultValue_other: "Search all {{count}} browser tabs",
        })}
        title={t("workspace.tools.browserTabOverflow.searchAllTabs", "Search all tabs")}
      >
        <ChevronsUpDownIcon className="size-3.5" />
      </Button>
    </PopoverTrigger>
  );
}

function OverflowPanel({
  inputRef,
  listId,
  query,
  filteredCount,
  activeIndex,
  list,
  busy,
  onQueryChange,
  onKeyDown,
  onReopen,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  listId: string;
  query: string;
  filteredCount: number;
  activeIndex: number;
  list: ReactNode;
  busy: boolean;
  onQueryChange: (query: string) => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onReopen: () => void;
}): ReactElement {
  const { t } = useUiTranslation();
  return (
    <>
      <div className="flex items-center gap-2 border-b px-2 py-1.5">
        <SearchIcon className="size-3.5 text-muted-foreground" />
        <Input
          ref={inputRef}
          variant="ghost"
          role="combobox"
          aria-label={t(
            "workspace.tools.browserTabOverflow.searchBrowserTabs",
            "Search browser tabs",
          )}
          aria-controls={listId}
          aria-expanded
          aria-activedescendant={filteredCount > 0 ? `${listId}-option-${activeIndex}` : undefined}
          placeholder={t("workspace.tools.browserTabOverflow.searchTabs", "Search tabs")}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onKeyDown}
          className="h-7 px-0 text-sm"
        />
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label={t("workspace.tools.browserTabOverflow.browserTabs", "Browser tabs")}
      >
        {list}
      </div>
      <div className="border-t p-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          className="w-full justify-start"
          onClick={onReopen}
        >
          <RotateCcwIcon className="size-3.5" />
          {t("workspace.tools.browserTabOverflow.reopenLastClosedTab", "Reopen last closed tab")}
          <span {...KBD_HINT_PROPS} className="ml-auto">
            <ResolvedShortcutHint shortcutId="browser-reopen-tab" />
          </span>
        </Button>
      </div>
    </>
  );
}

function OverflowRow({
  item,
  isActive,
  open,
  id,
  active,
  onClose,
}: FilteredVirtualListRowContext<BrowserTabMetadata> & {
  id: string;
  active: boolean;
  onClose: (tabId: string) => void;
}): ReactElement {
  const { t } = useUiTranslation();
  const label = browserTabLabel(item, t);
  return (
    <div
      className={cn(
        "group flex h-9 items-center gap-1 px-1",
        isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
      )}
    >
      <button
        id={id}
        type="button"
        role="option"
        aria-selected={active}
        onClick={open}
        className="flex min-w-0 flex-1 items-center gap-2 px-1.5 text-left text-sm"
      >
        {active ? <CheckIcon className="size-3.5 shrink-0" /> : <span className="w-3.5" />}
        <BrowserPageIcon tab={item} />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{label}</span>
          <span className="block truncate text-[10px] text-muted-foreground">{item.url}</span>
        </span>
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t("workspace.tools.browserTabStrip.closeNamedTab", "Close {{label}}", {
          label,
        })}
        className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        onClick={() => onClose(item.id)}
      >
        <XIcon className="size-3" />
      </Button>
    </div>
  );
}

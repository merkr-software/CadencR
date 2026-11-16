import { useLayoutEffect, useRef, type KeyboardEvent, type ReactElement } from "react";
import { ListFilter, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { isEditableShortcutTarget } from "@/lib/shortcuts/dom-targets";
import { useSidebarFilterStore, type FilterOrigin } from "@/stores/sidebar-filter-store";

/**
 * Starts the sidebar filter when a printable key is typed while focus is on a
 * sidebar row (not in a field). Modified keys stay shortcuts, and Space still
 * activates the focused row.
 */
export function handleSidebarTypeToFilter(event: KeyboardEvent<HTMLElement>): void {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key.length !== 1 || event.key === " ") return;
  if (isEditableShortcutTarget(event.target)) return;
  event.preventDefault();
  // Read before the filter re-renders the list: the row may not survive it.
  const row =
    event.target instanceof HTMLElement ? event.target.closest<HTMLElement>("[data-nav-id]") : null;
  const origin =
    row?.dataset.navType && row.dataset.navId
      ? { navType: row.dataset.navType, navId: row.dataset.navId }
      : null;
  useSidebarFilterStore.getState().start(event.key, origin);
}

function firstVisibleRow(from: HTMLElement): HTMLElement | null {
  return (
    from.closest("[data-app-sidebar]")?.querySelector<HTMLElement>('[data-nav-type="feature"]') ??
    null
  );
}

/**
 * The filter field, shown once typing starts in the sidebar. Escape clears it
 * and hands focus back to the row it came from, ↓ moves into the results, and
 * Enter opens the first one.
 */
export function SidebarFilterInput(): ReactElement | null {
  const isOpen = useSidebarFilterStore((state) => state.isOpen);
  return isOpen ? <OpenSidebarFilterInput /> : null;
}

/**
 * Hands focus back to the row typing started from. Filtering can unmount that
 * row, so it is found again by its nav identity once the full list re-rendered.
 */
function restoreFocus(origin: FilterOrigin | null): void {
  if (!origin) return;
  requestAnimationFrame(() => {
    const selector = `[data-nav-type="${origin.navType}"][data-nav-id="${origin.navId}"]`;
    document.querySelector<HTMLElement>(`[data-app-sidebar] ${selector}`)?.focus();
  });
}

function OpenSidebarFilterInput(): ReactElement {
  const query = useSidebarFilterStore((state) => state.query);
  const focusRequest = useSidebarFilterStore((state) => state.focusRequest);
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, [focusRequest]);

  const close = (): void => {
    const { origin } = useSidebarFilterStore.getState();
    useSidebarFilterStore.getState().close();
    restoreFocus(origin);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown" || event.key === "Enter") {
      const row = firstVisibleRow(event.currentTarget);
      if (!row) return;
      event.preventDefault();
      if (event.key === "Enter") row.click();
      else row.focus();
    }
  };

  return (
    <div className="mb-2 flex shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-background/40 px-2 mx-1">
      <ListFilter className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <Input
        ref={inputRef}
        variant="ghost"
        value={query}
        aria-label="Filter conversations"
        placeholder="Filter conversations"
        className="h-7 text-xs"
        onChange={(event) => useSidebarFilterStore.getState().setQuery(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (!useSidebarFilterStore.getState().query) useSidebarFilterStore.getState().close();
        }}
      />
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={close}
        aria-label="Clear filter"
        title="Clear filter (Esc)"
        className="text-muted-foreground"
      >
        <X />
      </Button>
    </div>
  );
}

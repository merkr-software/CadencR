import { useEffect, useId, useMemo, useState, type ReactElement } from "react";
import { Archive, CornerDownLeft, History, Search, X } from "lucide-react";
import { useShortcutLabel } from "@/hooks/useShortcutLabel";
import { matchesSidebarFilter, sidebarFilterTerms } from "@/lib/sidebar-filter";
import { usePromptStashStore, type StashedDraft } from "@/stores/prompt-stash-store";
import { ComposerPopoverGroup, ComposerPopoverOption, composerOptionId } from "./ComposerPopover";

type Row = { kind: "stash"; text: string; draft: StashedDraft } | { kind: "history"; text: string };

const EMPTY_STASH: StashedDraft[] = [];

/** Searchable list: stashed drafts first, then recent prompts. Enter restores. */
export function HistoryPanel({
  projectId,
  history,
  onPick,
}: {
  projectId: number;
  history: string[];
  onPick: (text: string) => void;
}): ReactElement {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listId = useId();
  const stash = usePromptStashStore((state) => state.byProject[projectId] ?? EMPTY_STASH);
  useEffect(() => {
    usePromptStashStore.getState().load(projectId);
  }, [projectId]);

  const stashLabel = useShortcutLabel("prompt-stash-draft");
  const rows = useMemo<Row[]>(() => {
    const terms = sidebarFilterTerms(query);
    return [
      ...stash
        .filter((draft) => matchesSidebarFilter(terms, [draft.text]))
        .map((draft): Row => ({ kind: "stash", text: draft.text, draft })),
      ...history
        .filter((entry) => matchesSidebarFilter(terms, [entry]))
        .slice(0, 50)
        .map((entry): Row => ({ kind: "history", text: entry })),
    ];
  }, [history, query, stash]);
  useEffect(() => setSelected(0), [query]);

  const pick = (row: Row | undefined): void => {
    if (!row) return;
    if (row.kind === "stash") usePromptStashStore.getState().remove(projectId, row.draft.stashedAt);
    onPick(row.text);
  };
  const stashRows = rows.filter((row) => row.kind === "stash");
  const historyRows = rows.filter((row) => row.kind === "history");
  const renderRow = (row: Row, index: number): ReactElement => (
    <HistoryRow
      key={
        row.kind === "stash" ? `s-${row.draft.stashedAt}` : `h-${index}-${row.text.slice(0, 24)}`
      }
      row={row}
      listId={listId}
      index={index}
      selected={index === selected}
      onPick={pick}
      onDelete={(draft) => usePromptStashStore.getState().remove(projectId, draft.stashedAt)}
    />
  );

  return (
    <div className="flex max-h-[min(26rem,60vh)] flex-col">
      <HistorySearchInput
        query={query}
        onQueryChange={setQuery}
        listId={listId}
        activeOption={rows.length > 0 ? composerOptionId(listId, selected) : undefined}
        onMove={(delta) =>
          setSelected((index) => Math.min(rows.length - 1, Math.max(0, index + delta)))
        }
        onPick={() => pick(rows[selected])}
      />
      <div
        id={listId}
        role="listbox"
        aria-label="Prompt history"
        className="min-h-0 flex-1 overflow-y-auto py-1"
      >
        {rows.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground" role="status">
            {query ? "Nothing matches." : "No prompts yet in this project."}
          </p>
        ) : (
          <>
            {stashRows.length > 0 && (
              <ComposerPopoverGroup label="Stashed drafts">
                {stashRows.map((row, index) => renderRow(row, index))}
              </ComposerPopoverGroup>
            )}
            {historyRows.length > 0 && (
              <ComposerPopoverGroup label="Recent prompts">
                {historyRows.map((row, index) => renderRow(row, stashRows.length + index))}
              </ComposerPopoverGroup>
            )}
          </>
        )}
      </div>
      <div
        aria-hidden
        className="flex items-center gap-3 border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground"
      >
        <span className="inline-flex items-center gap-1">
          <CornerDownLeft className="size-3" /> restore into the composer
        </span>
        <span>{stashLabel} stashes the current draft</span>
      </div>
    </div>
  );
}

function HistoryRow({
  row,
  listId,
  index,
  selected,
  onPick,
  onDelete,
}: {
  row: Row;
  listId: string;
  index: number;
  selected: boolean;
  onPick: (row: Row) => void;
  onDelete: (draft: StashedDraft) => void;
}): ReactElement {
  const Icon = row.kind === "stash" ? Archive : History;
  return (
    <ComposerPopoverOption
      listId={listId}
      index={index}
      selected={selected}
      onSelect={() => onPick(row)}
      className="items-start"
    >
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap break-words text-[13px]">
        {row.text}
      </span>
      {row.kind === "stash" && (
        <button
          type="button"
          aria-label="Delete stashed draft"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onDelete(row.draft);
          }}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </ComposerPopoverOption>
  );
}

function HistorySearchInput({
  query,
  onQueryChange,
  listId,
  activeOption,
  onMove,
  onPick,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  listId: string;
  activeOption: string | undefined;
  onMove: (delta: number) => void;
  onPick: () => void;
}): ReactElement {
  return (
    <label className="flex items-center gap-2 border-b border-border/70 px-3 py-2">
      <Search className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        autoFocus
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            onMove(event.key === "ArrowDown" ? 1 : -1);
          } else if (event.key === "Enter") {
            event.preventDefault();
            onPick();
          }
        }}
        placeholder="Search your prompts and stashed drafts"
        aria-label="Search prompt history"
        aria-controls={listId}
        aria-activedescendant={activeOption}
        className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
      />
    </label>
  );
}

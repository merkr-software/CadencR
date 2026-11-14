import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { Virtuoso } from "react-virtuoso";
import {
  CaseSensitive,
  ClipboardCopyIcon,
  FileTextIcon,
  FolderOpenIcon,
  WholeWord,
  Regex,
  Loader2,
} from "lucide-react";
import SearchToggleButton from "./SearchToggleButton";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useContentSearch, type ContentMatch, type ContentSearchParams } from "@/api/generated";
import { useOpenEditorFile } from "@/hooks/useOpenEditorFile";
import { SearchIcon } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FileSymbolIcon } from "./file-icons";
import SearchResultEditor from "./SearchResultEditor";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import { copyToClipboard } from "@/lib/clipboard";
import { ContextMenuActionItem } from "@/components/ContextMenuActionItem";

interface ContentSearchDialogProps {
  projectId: number;
  featureId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResultOpen?: () => void;
}

const DEBOUNCE_MS = 300;

interface SearchFilters {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  isRegex: boolean;
  respectGitignore: boolean;
  includePattern: string;
  excludePattern: string;
}

const defaultFilters: SearchFilters = {
  query: "",
  caseSensitive: false,
  wholeWord: false,
  isRegex: false,
  respectGitignore: true,
  includePattern: "",
  excludePattern: "",
};

/** Persists filter state per feature across dialog open/close cycles. */
const filterCache = new Map<number, SearchFilters>();

function useContentSearchFilters(featureId: number, open: boolean) {
  const cached = filterCache.get(featureId) ?? defaultFilters;
  const [query, setQuery] = useState(cached.query);
  const [caseSensitive, setCaseSensitive] = useState(cached.caseSensitive);
  const [wholeWord, setWholeWord] = useState(cached.wholeWord);
  const [isRegex, setIsRegex] = useState(cached.isRegex);
  const [respectGitignore, setRespectGitignore] = useState(cached.respectGitignore);
  const [includePattern, setIncludePattern] = useState(cached.includePattern);
  const [excludePattern, setExcludePattern] = useState(cached.excludePattern);
  useEffect(() => {
    filterCache.set(featureId, {
      query,
      caseSensitive,
      wholeWord,
      isRegex,
      respectGitignore,
      includePattern,
      excludePattern,
    });
  }, [
    featureId,
    query,
    caseSensitive,
    wholeWord,
    isRegex,
    respectGitignore,
    includePattern,
    excludePattern,
  ]);
  const debouncedQuery = useDebouncedValue(query, DEBOUNCE_MS);
  useEffect(() => {
    if (!open) return;
    const restored = filterCache.get(featureId) ?? defaultFilters;
    setQuery(restored.query);
    setCaseSensitive(restored.caseSensitive);
    setWholeWord(restored.wholeWord);
    setIsRegex(restored.isRegex);
    setRespectGitignore(restored.respectGitignore);
    setIncludePattern(restored.includePattern);
    setExcludePattern(restored.excludePattern);
  }, [open, featureId]);
  return useMemo(
    () => ({
      caseSensitive,
      debouncedQuery,
      excludePattern,
      includePattern,
      isRegex,
      query,
      respectGitignore,
      setCaseSensitive,
      setExcludePattern,
      setIncludePattern,
      setIsRegex,
      setQuery,
      setRespectGitignore,
      setWholeWord,
      wholeWord,
    }),
    [
      caseSensitive,
      debouncedQuery,
      excludePattern,
      includePattern,
      isRegex,
      query,
      respectGitignore,
      wholeWord,
    ],
  );
}

function useContentSearchResults({
  featureId,
  filters,
  onOpenChange,
  onResultOpen,
  open,
  projectId,
}: ContentSearchDialogProps & { filters: ReturnType<typeof useContentSearchFilters> }) {
  const openFile = useOpenEditorFile(featureId);
  const searchParams: ContentSearchParams = useMemo(
    () => ({
      project_id: projectId,
      feature_id: featureId,
      query: filters.debouncedQuery,
      case_sensitive: filters.caseSensitive,
      whole_word: filters.wholeWord,
      is_regex: filters.isRegex,
      respect_gitignore: filters.respectGitignore,
      include_pattern: filters.includePattern || undefined,
      exclude_pattern: filters.excludePattern || undefined,
    }),
    [featureId, filters, projectId],
  );
  const { data, isLoading, isFetching } = useContentSearch(searchParams, {
    query: {
      enabled: open && filters.debouncedQuery.length > 0,
      placeholderData: keepPreviousData,
    },
  });
  const hasQuery = filters.debouncedQuery.length > 0;
  const searching = isFetching && hasQuery;
  const handleSelect = useCallback(
    (filePath: string, lineNumber?: number): void => {
      openFile(filePath, lineNumber);
      onResultOpen?.();
      onOpenChange(false);
    },
    [openFile, onResultOpen, onOpenChange],
  );
  const grouped = useMemo(() => groupByFile(data?.matches ?? []), [data?.matches]);
  const computeItemKey = useCallback((_: number, group: FileGroupData) => group.path, []);
  const itemContent = useCallback(
    (_: number, group: FileGroupData) => <FileGroup group={group} onSelect={handleSelect} />,
    [handleSelect],
  );
  const components = useMemo(
    () => (data?.truncated ? { Footer: TruncatedFooter } : {}),
    [data?.truncated],
  );
  return useMemo(
    () => ({ components, computeItemKey, grouped, hasQuery, isLoading, itemContent, searching }),
    [components, computeItemKey, grouped, hasQuery, isLoading, itemContent, searching],
  );
}

export default function ContentSearchDialog(props: ContentSearchDialogProps) {
  const filters = useContentSearchFilters(props.featureId, props.open);
  const results = useContentSearchResults({ ...props, filters });
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-[900px] h-[80vh] !flex !flex-col gap-2 p-0 pt-3 overflow-hidden"
      >
        <ContentSearchHeader filters={filters} searching={results.searching} />
        <ContentSearchPatterns filters={filters} />
        <ContentSearchResults results={results} />
      </DialogContent>
    </Dialog>
  );
}

function ContentSearchHeader({
  filters,
  searching,
}: {
  filters: ReturnType<typeof useContentSearchFilters>;
  searching: boolean;
}) {
  return (
    <div className="flex items-center border-b border-border px-3 pb-2 gap-2">
      {searching ? (
        <Loader2 className="size-4 shrink-0 opacity-50 animate-spin" />
      ) : (
        <SearchIcon className="size-4 shrink-0 opacity-50" />
      )}
      <Input
        autoFocus
        variant="ghost"
        placeholder="Search in files..."
        value={filters.query}
        onChange={(event) => filters.setQuery(event.target.value)}
        className="flex-1"
      />
      <div className="flex items-center gap-1 shrink-0">
        <SearchToggleButton
          active={filters.caseSensitive}
          onToggle={filters.setCaseSensitive}
          title="Case Sensitive"
          icon={<CaseSensitive className="w-4 h-4" />}
        />
        <SearchToggleButton
          active={filters.wholeWord}
          onToggle={filters.setWholeWord}
          title="Whole Word"
          icon={<WholeWord className="w-4 h-4" />}
        />
        <SearchToggleButton
          active={filters.isRegex}
          onToggle={filters.setIsRegex}
          title="Regex"
          icon={<Regex className="w-4 h-4" />}
        />
        <SearchToggleButton
          active={filters.respectGitignore}
          onToggle={filters.setRespectGitignore}
          title="Only search git-tracked files"
          label="Git only"
        />
      </div>
    </div>
  );
}

function ContentSearchPatterns({
  filters,
}: {
  filters: ReturnType<typeof useContentSearchFilters>;
}) {
  return (
    <div className="flex items-center gap-2 px-3 border-b border-border pb-2">
      <Input
        variant="ghost"
        placeholder="Include (e.g. *.ts, src/**)"
        value={filters.includePattern}
        onChange={(event) => filters.setIncludePattern(event.target.value)}
        className="flex-1 text-xs"
      />
      <div className="w-px h-5 bg-border shrink-0" />
      <Input
        variant="ghost"
        placeholder="Exclude (e.g. *.test.ts, dist/**)"
        value={filters.excludePattern}
        onChange={(event) => filters.setExcludePattern(event.target.value)}
        className="flex-1 text-xs"
      />
    </div>
  );
}

function ContentSearchResults({
  results,
}: {
  results: ReturnType<typeof useContentSearchResults>;
}) {
  const empty = results.grouped.length === 0;
  return (
    <div className="flex-1 min-h-0">
      {results.isLoading && results.hasQuery && empty && (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          Searching...
        </div>
      )}
      {!results.searching && results.hasQuery && empty && (
        <div className="py-8 text-center text-sm text-muted-foreground">No results found.</div>
      )}
      {!empty && (
        <Virtuoso
          data={results.grouped}
          className="h-full"
          computeItemKey={results.computeItemKey}
          itemContent={results.itemContent}
          components={results.components}
        />
      )}
    </div>
  );
}

function TruncatedFooter(): ReactElement {
  return (
    <div className="py-2 text-center text-xs text-muted-foreground">
      Results capped at 500. Refine your search for more specific results.
    </div>
  );
}

interface FileGroupData {
  path: string;
  matches: ContentMatch[];
}

function groupByFile(matches: ContentMatch[]): FileGroupData[] {
  const map = new Map<string, ContentMatch[]>();
  for (const m of matches) {
    const existing = map.get(m.path);
    if (existing) {
      existing.push(m);
    } else {
      map.set(m.path, [m]);
    }
  }
  return Array.from(map.entries()).map(([path, ms]) => ({ path, matches: ms }));
}

const FileGroup = memo(function FileGroup({
  group,
  onSelect,
}: {
  group: FileGroupData;
  onSelect: (filePath: string, lineNumber?: number) => void;
}) {
  const fileName = group.path.split("/").pop() ?? group.path;
  const firstMatchLine = group.matches[0]?.line_number ?? 1;

  return (
    <div className="pb-3">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={() => onSelect(group.path, firstMatchLine)}
            className="flex items-center gap-1.5 px-2 py-1 w-full text-left text-xs font-medium text-foreground hover:bg-accent rounded transition-colors"
          >
            <FileSymbolIcon fileName={fileName} className="shrink-0 flex items-center" />
            <span className="truncate">{group.path}</span>
            <span className="ml-auto text-muted-foreground shrink-0">{group.matches.length}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuActionItem
            icon={FolderOpenIcon}
            onSelect={() => onSelect(group.path, firstMatchLine)}
          >
            Open
          </ContextMenuActionItem>
          <ContextMenuActionItem
            icon={ClipboardCopyIcon}
            onSelect={() => void copyToClipboard(group.path, "Path copied")}
          >
            Copy Path
          </ContextMenuActionItem>
          <ContextMenuActionItem
            icon={FileTextIcon}
            onSelect={() =>
              void copyToClipboard(group.matches[0]?.line_content ?? "", "Match copied")
            }
          >
            Copy Match
          </ContextMenuActionItem>
        </ContextMenuContent>
      </ContextMenu>
      <div className="mt-1">
        <SearchResultEditor
          filePath={group.path}
          matches={group.matches}
          onClick={(lineNumber) => onSelect(group.path, lineNumber)}
        />
      </div>
    </div>
  );
});

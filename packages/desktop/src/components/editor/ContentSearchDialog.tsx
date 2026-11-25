import { useCallback, useEffect, useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { Virtuoso } from "react-virtuoso";
import { CaseSensitive, WholeWord, Regex, Loader2 } from "lucide-react";
import { ContentSearchFileGroup } from "./ContentSearchFileGroup";
import SearchToggleButton from "./SearchToggleButton";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import { useSetting } from "@/hooks/useSetting";
import { useContentSearch, type ContentSearchParams } from "@/api/generated";
import { SkippedLargeFilesNotice, TruncatedFooter } from "./ContentSearchNotices";
import { groupByFile, type FileGroupData } from "./contentSearchGroups";
import { useEditorState } from "@/hooks/useEditorState";
import { SearchIcon } from "lucide-react";
import { apiErrorMessage } from "@/lib/api-errors";
import { useUiTranslation } from "@/lib/i18n/ui";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

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
  const { activePaneId, openFile } = useEditorState(featureId);
  const { value: maxTabsSetting } = useSetting("editor_max_tabs");
  const maxTabs = parseInt(maxTabsSetting ?? "10", 10);
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
  const { data, error, isLoading, isFetching } = useContentSearch(searchParams, {
    query: {
      enabled: open && filters.debouncedQuery.length > 0,
      placeholderData: keepPreviousData,
    },
  });
  const hasQuery = filters.debouncedQuery.length > 0;
  const searching = isFetching && hasQuery;
  const handleSelect = useCallback(
    (filePath: string, lineNumber?: number): void => {
      openFile(activePaneId ?? "main", filePath, maxTabs, lineNumber);
      onResultOpen?.();
      onOpenChange(false);
    },
    [openFile, activePaneId, maxTabs, onResultOpen, onOpenChange],
  );
  const grouped = useMemo(() => groupByFile(data?.matches ?? []), [data?.matches]);
  const computeItemKey = useCallback((_: number, group: FileGroupData) => group.path, []);
  const itemContent = useCallback(
    (_: number, group: FileGroupData) => (
      <ContentSearchFileGroup group={group} onSelect={handleSelect} />
    ),
    [handleSelect],
  );
  const components = useMemo(
    () => (data?.truncated ? { Footer: TruncatedFooter } : {}),
    [data?.truncated],
  );
  const skippedLargeFiles = data?.skipped_large_files ?? 0;
  const maxFileBytes = data?.max_file_bytes ?? 0;
  return useMemo(
    () => ({
      components,
      computeItemKey,
      error,
      grouped,
      hasQuery,
      isLoading,
      itemContent,
      maxFileBytes,
      searching,
      skippedLargeFiles,
    }),
    [
      components,
      computeItemKey,
      error,
      grouped,
      hasQuery,
      isLoading,
      itemContent,
      maxFileBytes,
      searching,
      skippedLargeFiles,
    ],
  );
}

export default function ContentSearchDialog(props: ContentSearchDialogProps) {
  const { t } = useUiTranslation();
  const filters = useContentSearchFilters(props.featureId, props.open);
  const results = useContentSearchResults({ ...props, filters });
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-[900px] h-[80vh] !flex !flex-col gap-2 p-0 pt-3 overflow-hidden"
      >
        <DialogTitle className="sr-only">
          {t("search.content.title", "Search in files")}
        </DialogTitle>
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
  const { t } = useUiTranslation();
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
        placeholder={t("search.content.placeholder", "Search in files...")}
        value={filters.query}
        onChange={(event) => filters.setQuery(event.target.value)}
        className="flex-1"
      />
      <div className="flex items-center gap-1 shrink-0">
        <SearchToggleButton
          active={filters.caseSensitive}
          onToggle={filters.setCaseSensitive}
          title={t("search.content.caseSensitive", "Case Sensitive")}
          icon={<CaseSensitive className="w-4 h-4" />}
        />
        <SearchToggleButton
          active={filters.wholeWord}
          onToggle={filters.setWholeWord}
          title={t("search.content.wholeWord", "Whole Word")}
          icon={<WholeWord className="w-4 h-4" />}
        />
        <SearchToggleButton
          active={filters.isRegex}
          onToggle={filters.setIsRegex}
          title={t("search.content.regex", "Regex")}
          icon={<Regex className="w-4 h-4" />}
        />
        <SearchToggleButton
          active={filters.respectGitignore}
          onToggle={filters.setRespectGitignore}
          title={t("search.content.gitOnlyHint", "Only search git-tracked files")}
          label={t("search.content.gitOnly", "Git only")}
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
  const { t } = useUiTranslation();
  return (
    <div className="flex items-center gap-2 px-3 border-b border-border pb-2">
      <Input
        variant="ghost"
        placeholder={t("search.content.include", "Include (e.g. {{patterns}})", {
          patterns: "*.ts, src/**",
        })}
        value={filters.includePattern}
        onChange={(event) => filters.setIncludePattern(event.target.value)}
        className="flex-1 text-xs"
      />
      <div className="w-px h-5 bg-border shrink-0" />
      <Input
        variant="ghost"
        placeholder={t("search.content.exclude", "Exclude (e.g. {{patterns}})", {
          patterns: "*.test.ts, dist/**",
        })}
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
  const { t } = useUiTranslation();
  const empty = results.grouped.length === 0;
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {results.hasQuery && (
        <SkippedLargeFilesNotice
          count={results.skippedLargeFiles}
          maxFileBytes={results.maxFileBytes}
        />
      )}
      {results.isLoading && results.hasQuery && empty && (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          {t("search.content.searching", "Searching...")}
        </div>
      )}
      {results.error && results.hasQuery && (
        <div role="alert" className="py-8 text-center text-sm text-destructive">
          {apiErrorMessage(results.error, t("search.content.error", "Search in files failed"))}
        </div>
      )}
      {!results.error && !results.searching && results.hasQuery && empty && (
        <div className="py-8 text-center text-sm text-muted-foreground">
          {t("search.content.empty", "No results found.")}
        </div>
      )}
      {!empty && (
        <Virtuoso
          data={results.grouped}
          className="flex-1 min-h-0"
          computeItemKey={results.computeItemKey}
          itemContent={results.itemContent}
          components={results.components}
        />
      )}
    </div>
  );
}

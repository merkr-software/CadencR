import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { EditorView } from "@codemirror/view";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import {
  MAX_BUFFER_MATCHES,
  closeBufferSearch,
  findNextMatch,
  findPrevMatch,
  getBufferSearchState,
  replaceActiveMatch,
  replaceAllMatches,
  selectActiveMatch,
  setBufferSearchQuery,
  subscribeBufferSearch,
} from "./search-extension";
import { getPaneSearch, setPaneSearch } from "./search-cache";
import { EditorReplaceRow } from "./EditorReplaceRow";
import { SearchInputRow, SearchPanelControls } from "./EditorSearchInputs";

interface EditorSearchPanelProps {
  view: EditorView;
  /**
   * Identifies which pane's persisted search state to hydrate from and write
   * back to. The panel reads the cache lazily on every mount, so reopening
   * Cmd+F after closing restores the user's last query.
   */
  featureId: number;
  paneId: string;
  /** Bumped by the parent every time Cmd+F is pressed while the panel is already open. */
  reopenSignal: number;
  /** When true, render the replace row below the find row. */
  replaceMode?: boolean;
  /** Bumped every time the replace shortcut is pressed; focuses the replace input. */
  replaceFocusSignal?: number;
  onClose: () => void;
}

const QUERY_DEBOUNCE_MS = 80;

interface MatchInfo {
  total: number;
  active: number;
  truncated: boolean;
  error: string | null;
}

function usePersistedSearchState(featureId: number, paneId: string) {
  const cached = (): ReturnType<typeof getPaneSearch> => getPaneSearch(featureId, paneId);
  const [query, setQueryState] = useState<string>(() => cached().query);
  const [caseSensitive, setCaseSensitiveState] = useState<boolean>(() => cached().caseSensitive);
  const [regex, setRegexState] = useState<boolean>(() => cached().regex);
  const [replacement, setReplacementState] = useState<string>(() => cached().replacement ?? "");
  const stateRef = useRef({ query, caseSensitive, regex, replacement });
  stateRef.current = { query, caseSensitive, regex, replacement };
  const persist = useCallback(
    (patch: Partial<typeof stateRef.current>): void => {
      setPaneSearch(featureId, paneId, { ...stateRef.current, ...patch });
    },
    [featureId, paneId],
  );
  const setQuery = useCallback(
    (next: string): void => {
      setQueryState(next);
      persist({ query: next });
    },
    [persist],
  );
  const setCaseSensitive = useCallback(
    (next: boolean): void => {
      setCaseSensitiveState(next);
      persist({ caseSensitive: next });
    },
    [persist],
  );
  const setRegex = useCallback(
    (next: boolean): void => {
      setRegexState(next);
      persist({ regex: next });
    },
    [persist],
  );
  const setReplacement = useCallback(
    (next: string): void => {
      setReplacementState(next);
      persist({ replacement: next });
    },
    [persist],
  );
  return useMemo(
    () => ({
      query,
      caseSensitive,
      regex,
      replacement,
      setQuery,
      setCaseSensitive,
      setRegex,
      setReplacement,
    }),
    [
      caseSensitive,
      query,
      regex,
      replacement,
      setCaseSensitive,
      setQuery,
      setRegex,
      setReplacement,
    ],
  );
}

function useEditorSearchActions(view: EditorView, onClose: () => void, replacement: string) {
  const handleNext = useCallback((): void => findNextMatch(view), [view]);
  const handlePrev = useCallback((): void => findPrevMatch(view), [view]);
  const handleClose = useCallback((): void => {
    closeBufferSearch(view);
    onClose();
    view.focus();
  }, [onClose, view]);
  const handleReplaceOne = useCallback((): void => {
    replaceActiveMatch(view, replacement);
  }, [replacement, view]);
  const handleReplaceAll = useCallback((): void => {
    replaceAllMatches(view, replacement);
  }, [replacement, view]);
  const handleReplaceKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (event.metaKey || event.ctrlKey) handleReplaceAll();
        else handleReplaceOne();
      }
    },
    [handleClose, handleReplaceAll, handleReplaceOne],
  );
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        handleClose();
        return;
      }
      if (event.key !== "Enter") return;
      event.preventDefault();
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey) {
        selectActiveMatch(view);
        event.currentTarget.blur();
        view.focus();
      } else if (event.shiftKey) handlePrev();
      else handleNext();
    },
    [handleClose, handleNext, handlePrev, view],
  );
  return useMemo(
    () => ({
      handleNext,
      handlePrev,
      handleClose,
      handleReplaceOne,
      handleReplaceAll,
      handleReplaceKeyDown,
      handleKeyDown,
    }),
    [
      handleClose,
      handleKeyDown,
      handleNext,
      handlePrev,
      handleReplaceAll,
      handleReplaceKeyDown,
      handleReplaceOne,
    ],
  );
}

function EditorSearchPanel({
  view,
  featureId,
  paneId,
  reopenSignal,
  replaceMode = false,
  replaceFocusSignal = 0,
  onClose,
}: EditorSearchPanelProps) {
  const { t } = useUiTranslation();
  const state = usePersistedSearchState(featureId, paneId);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);

  const debouncedQuery = useDebouncedValue(state.query, QUERY_DEBOUNCE_MS);

  useEffect(() => {
    setBufferSearchQuery(view, {
      query: debouncedQuery,
      caseSensitive: state.caseSensitive,
      regex: state.regex,
    });
  }, [debouncedQuery, state.caseSensitive, state.regex, view]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [reopenSignal]);

  // When the user opens replace (⌘⌥F) while the panel is already open,
  // focus the replace input directly instead of re-selecting the find row.
  useEffect(() => {
    if (!replaceMode) return;
    const el = replaceInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [replaceFocusSignal, replaceMode]);

  const matchInfo = useLiveMatchInfo(view);
  const actions = useEditorSearchActions(view, onClose, state.replacement);
  const counterLabel = useMemo(
    () => buildCounterLabel(state.query, matchInfo, t),
    [matchInfo, state.query, t],
  );
  const hasError = matchInfo.error !== null;
  const showNoMatches = state.query.length > 0 && matchInfo.total === 0 && !hasError;

  return (
    <div
      className="absolute top-2 right-3 z-20 flex flex-col rounded-md border border-border bg-card/95 px-2 py-1 shadow-md backdrop-blur"
      role="search"
      aria-label={
        replaceMode
          ? t("workspace.editor.editorSearchPanel.findAndReplaceInFile", "Find and replace in file")
          : t("workspace.editor.editorSearchPanel.findInFile", "Find in file")
      }
      onMouseDown={(event) => {
        const target = event.target;
        if (target !== inputRef.current && target !== replaceInputRef.current) {
          event.preventDefault();
        }
      }}
    >
      <div className="flex items-center gap-1">
        <SearchInputRow
          inputRef={inputRef}
          query={state.query}
          onQueryChange={state.setQuery}
          onKeyDown={actions.handleKeyDown}
          counterLabel={counterLabel}
          hasError={hasError}
          errorTitle={matchInfo.error}
          muted={showNoMatches}
        />
        <SearchPanelControls
          disabled={matchInfo.total === 0}
          caseSensitive={state.caseSensitive}
          regex={state.regex}
          onPrev={actions.handlePrev}
          onNext={actions.handleNext}
          onToggleCase={state.setCaseSensitive}
          onToggleRegex={state.setRegex}
          onClose={actions.handleClose}
        />
      </div>
      {replaceMode && (
        <EditorReplaceRow
          inputRef={replaceInputRef}
          replacement={state.replacement}
          onReplacementChange={state.setReplacement}
          onReplaceOne={actions.handleReplaceOne}
          onReplaceAll={actions.handleReplaceAll}
          onKeyDown={actions.handleReplaceKeyDown}
          disabled={matchInfo.total === 0}
        />
      )}
    </div>
  );
}

function useLiveMatchInfo(view: EditorView): MatchInfo {
  const [info, setInfo] = useState<MatchInfo>(() => readMatchInfo(view));
  useEffect(() => {
    setInfo(readMatchInfo(view));
    return subscribeBufferSearch(view, (state) => {
      setInfo({
        total: state.matches.length,
        active: state.activeIndex,
        truncated: state.truncated,
        error: state.error,
      });
    });
  }, [view]);
  return info;
}

function readMatchInfo(view: EditorView): MatchInfo {
  const s = getBufferSearchState(view);
  return {
    total: s.matches.length,
    active: s.activeIndex,
    truncated: s.truncated,
    error: s.error,
  };
}

function buildCounterLabel(query: string, info: MatchInfo, t: UiTranslator): string {
  if (info.error) return t("workspace.editor.editorSearchPanel.badRegex", "Bad regex");
  if (!query) return "";
  if (info.total === 0) return t("workspace.editor.editorSearchPanel.noResults", "No results");
  const totalLabel = info.truncated ? `${MAX_BUFFER_MATCHES}+` : `${info.total}`;
  // When matches exist but no active match is highlighted (transient states
  // between dispatches), render an em-dash rather than a misleading "1 of N".
  const activeLabel = info.active >= 0 ? String(info.active + 1) : "–";
  return t("workspace.editor.editorSearchPanel.resultPosition", "{{active}} of {{total}}", {
    active: activeLabel,
    total: totalLabel,
  });
}

export default memo(EditorSearchPanel);

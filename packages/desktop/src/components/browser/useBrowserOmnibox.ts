import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { desktopBridge, type BrowserTabMetadata } from "@/lib/desktop-bridge";
import { buildOmniboxSuggestions, type BrowserOmniboxSuggestion } from "@/lib/browser-omnibox";
import { PROFILE_ID, type BrowserSearchEngine } from "@/lib/browser-settings";
import {
  MAX_BROWSER_LIBRARY_QUERY_LENGTH,
  MAX_BROWSER_LIBRARY_URL_LENGTH,
  type BrowserOmniboxQueryResult,
} from "@/shared/browser-types";
import { isHttpBrowserUrl } from "@/shared/browser-url";

const QUERY_DELAY_MS = 75;
const EMPTY_RESULT: BrowserOmniboxQueryResult = {
  bookmarkCount: 0,
  bookmarks: [],
  historyCount: 0,
  history: [],
};

interface UseBrowserOmniboxArgs {
  enabled: boolean;
  query: string;
  tabs: BrowserTabMetadata[];
  activeTab: BrowserTabMetadata | null;
  searchEngine: BrowserSearchEngine;
}

export interface BrowserOmniboxController {
  suggestions: BrowserOmniboxSuggestion[];
  isQuerying: boolean;
  isBookmarked: boolean;
  mutationPending: boolean;
  historyCount: number;
  error: string | null;
  dismissError: () => void;
  toggleBookmark: () => Promise<void>;
  removeHistoryEntry: (id: string) => Promise<void>;
  clearHistory: () => Promise<void>;
}

export function useBrowserOmnibox(args: UseBrowserOmniboxArgs): BrowserOmniboxController {
  const { t } = useUiTranslation();
  const query = useLocalSuggestionQuery(args.enabled, args.query);
  const bookmark = useActiveBookmark(args.activeTab);
  const actions = useLibraryActions(args.activeTab, bookmark);
  const library = query.resultQuery === args.query ? query.result : EMPTY_RESULT;
  const suggestions = useMemo(
    () => buildOmniboxSuggestions(args.query, args.tabs, library, args.searchEngine),
    [args.query, args.searchEngine, args.tabs, library],
  );
  const dismissQueryError = query.dismissError;
  const dismissBookmarkError = bookmark.dismissError;
  const dismissActionError = actions.dismissError;
  const dismissError = useCallback(() => {
    dismissQueryError();
    dismissBookmarkError();
    dismissActionError();
  }, [dismissActionError, dismissBookmarkError, dismissQueryError]);
  const error = errorMessage(actions.error ?? bookmark.error ?? query.error, t);
  return useMemo(
    () => ({
      suggestions,
      isQuerying: query.pending,
      isBookmarked: bookmark.value,
      mutationPending: bookmark.loading || actions.pending,
      historyCount: library.historyCount,
      error,
      dismissError,
      toggleBookmark: actions.toggleBookmark,
      removeHistoryEntry: actions.removeHistoryEntry,
      clearHistory: actions.clearHistory,
    }),
    [
      actions.clearHistory,
      actions.pending,
      actions.removeHistoryEntry,
      actions.toggleBookmark,
      bookmark.loading,
      bookmark.value,
      dismissError,
      library.historyCount,
      error,
      query.pending,
      suggestions,
    ],
  );
}

interface SuggestionQueryState {
  result: BrowserOmniboxQueryResult;
  resultQuery: string;
  pending: boolean;
  error: OmniboxError | null;
  dismissError: () => void;
}

function useLocalSuggestionQuery(enabled: boolean, value: string): SuggestionQueryState {
  const [result, setResult] = useState(EMPTY_RESULT);
  const [resultQuery, setResultQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<OmniboxError | null>(null);
  const revision = useRef(0);
  const currentValue = useRef(value);
  currentValue.current = value;
  const run = useCallback(async (query: string): Promise<void> => {
    const request = ++revision.current;
    setPending(true);
    try {
      const lookupQuery = query.slice(0, MAX_BROWSER_LIBRARY_QUERY_LENGTH);
      const next = await desktopBridge.queryBrowserOmnibox(lookupQuery, 8);
      if (request !== revision.current) return;
      setResult(next);
      setResultQuery(query);
      setError(null);
    } catch (queryError) {
      if (request === revision.current) setError({ kind: "suggestions", cause: queryError });
    } finally {
      if (request === revision.current) setPending(false);
    }
  }, []);
  useEffect(() => {
    if (!enabled) {
      revision.current += 1;
      setPending(false);
      return;
    }
    const timer = window.setTimeout(() => void run(value), QUERY_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      revision.current += 1;
    };
  }, [enabled, run, value]);
  useEffect(() => {
    return desktopBridge.onBrowserLibraryChanged(() => {
      if (enabled) void run(currentValue.current);
    });
  }, [enabled, run]);
  const dismissError = useCallback(() => setError(null), []);
  return useMemo(
    () => ({ result, resultQuery, pending, error, dismissError }),
    [dismissError, error, pending, result, resultQuery],
  );
}

interface BookmarkState {
  value: boolean;
  loading: boolean;
  identity: string | null;
  error: OmniboxError | null;
  dismissError: () => void;
  invalidateRead: () => void;
  setConfirmed: (identity: string, value: boolean) => void;
}

function useActiveBookmark(activeTab: BrowserTabMetadata | null): BookmarkState {
  const identity = bookmarkIdentity(activeTab);
  const [confirmed, setConfirmedState] = useState<{ identity: string; value: boolean } | null>(
    null,
  );
  const [loadingIdentity, setLoadingIdentity] = useState<string | null>(null);
  const [error, setError] = useState<OmniboxError | null>(null);
  const revision = useRef(0);
  const activeUrl = activeTab?.url ?? null;
  const readBookmark = useCallback((): void => {
    if (!identity || !activeUrl) return;
    const request = ++revision.current;
    setLoadingIdentity(identity);
    void desktopBridge
      .getBrowserBookmark(activeUrl)
      .then((result) => {
        if (request !== revision.current) return;
        setConfirmedState({ identity, value: result !== null });
        setError(null);
      })
      .catch((queryError: unknown) => {
        if (request === revision.current) {
          setConfirmedState((current) =>
            current?.identity === identity ? current : { identity, value: false },
          );
          setError({ kind: "bookmarkRead", cause: queryError });
        }
      })
      .finally(() => {
        if (request === revision.current) setLoadingIdentity(null);
      });
  }, [activeUrl, identity]);
  useEffect(() => {
    revision.current += 1;
    setError(null);
    if (!identity || !activeUrl) {
      setConfirmedState(null);
      setLoadingIdentity(null);
      return;
    }
    readBookmark();
    return () => {
      revision.current += 1;
    };
  }, [activeUrl, identity, readBookmark]);
  useEffect(() => {
    if (!identity || !activeUrl) return;
    const activeUrlKey = bookmarkUrlKey(activeUrl);
    return desktopBridge.onBrowserLibraryChanged((change) => {
      if (change.kind !== "bookmark" || bookmarkUrlKey(change.url) !== activeUrlKey) return;
      readBookmark();
    });
  }, [activeUrl, identity, readBookmark]);
  const invalidateRead = useCallback(() => {
    revision.current += 1;
    setLoadingIdentity(null);
  }, []);
  const setConfirmed = useCallback((nextIdentity: string, value: boolean) => {
    setConfirmedState({ identity: nextIdentity, value });
  }, []);
  const dismissError = useCallback(() => setError(null), []);
  return useMemo(
    () => ({
      value: confirmed?.identity === identity ? confirmed.value : false,
      loading: Boolean(
        identity && (loadingIdentity === identity || confirmed?.identity !== identity),
      ),
      identity,
      error,
      dismissError,
      invalidateRead,
      setConfirmed,
    }),
    [confirmed, dismissError, error, identity, invalidateRead, loadingIdentity, setConfirmed],
  );
}

interface LibraryActions {
  pending: boolean;
  error: OmniboxError | null;
  dismissError: () => void;
  toggleBookmark: () => Promise<void>;
  removeHistoryEntry: (id: string) => Promise<void>;
  clearHistory: () => Promise<void>;
}

function useLibraryActions(
  activeTab: BrowserTabMetadata | null,
  bookmark: BookmarkState,
): LibraryActions {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<OmniboxError | null>(null);
  const inFlight = useRef(false);
  const activeIdentity = useRef(bookmark.identity);
  activeIdentity.current = bookmark.identity;
  const run = useCallback(
    async (operation: () => Promise<void>, kind: LibraryActionErrorKind): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      try {
        await operation();
        setError(null);
      } catch (actionError) {
        setError({ kind, cause: actionError });
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [],
  );
  const toggleBookmark = useCallback(async (): Promise<void> => {
    if (!activeTab || !bookmark.identity) return;
    if (inFlight.current) return;
    const identity = bookmark.identity;
    const nextValue = !bookmark.value;
    bookmark.invalidateRead();
    await run(async () => {
      const result = await desktopBridge.setBrowserBookmark(activeTab.id, nextValue);
      if (activeIdentity.current === identity) bookmark.setConfirmed(identity, result !== null);
    }, "bookmarkWrite");
  }, [activeTab, bookmark, run]);
  const removeHistoryEntry = useCallback(
    (id: string) =>
      run(async () => {
        await desktopBridge.removeBrowserHistoryEntry(id);
      }, "historyDelete"),
    [run],
  );
  const clearHistory = useCallback(
    () =>
      run(async () => {
        await desktopBridge.clearBrowserHistory();
      }, "historyClear"),
    [run],
  );
  const dismissError = useCallback(() => setError(null), []);
  return useMemo(
    () => ({ pending, error, dismissError, toggleBookmark, removeHistoryEntry, clearHistory }),
    [clearHistory, dismissError, error, pending, removeHistoryEntry, toggleBookmark],
  );
}

export function isPersistentTab(tab: BrowserTabMetadata | null): boolean {
  return Boolean(
    tab && tab.sessionProfileId !== PROFILE_ID.private && tab.sessionProfileId !== "feature",
  );
}

function bookmarkIdentity(tab: BrowserTabMetadata | null): string | null {
  if (
    !isPersistentTab(tab) ||
    !tab ||
    tab.url.length > MAX_BROWSER_LIBRARY_URL_LENGTH ||
    !isHttpBrowserUrl(tab.url)
  ) {
    return null;
  }
  return `${tab.id}\n${tab.url}`;
}

function bookmarkUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

type LibraryActionErrorKind = "bookmarkWrite" | "historyDelete" | "historyClear";

interface OmniboxError {
  kind: "suggestions" | "bookmarkRead" | LibraryActionErrorKind;
  cause: unknown;
}

function errorMessage(error: OmniboxError | null, t: UiTranslator): string | null {
  if (!error) return null;
  const { cause, kind } = error;
  if (cause instanceof Error && cause.message) return cause.message;
  switch (kind) {
    case "suggestions":
      return t(
        "workspace.tools.useBrowserOmnibox.couldNotLoadLocalBrowserSuggestions",
        "Could not load local Browser suggestions.",
      );
    case "bookmarkRead":
      return t(
        "workspace.tools.useBrowserOmnibox.couldNotCheckThisPageSBookmark",
        "Could not check this page's bookmark.",
      );
    case "bookmarkWrite":
      return t(
        "workspace.tools.useBrowserOmnibox.couldNotUpdateThisBookmark",
        "Could not update this bookmark.",
      );
    case "historyDelete":
      return t(
        "workspace.tools.useBrowserOmnibox.couldNotDeleteThisHistoryEntry",
        "Could not delete this history entry.",
      );
    case "historyClear":
      return t(
        "workspace.tools.useBrowserOmnibox.couldNotClearBrowserHistory",
        "Could not clear Browser history.",
      );
  }
}

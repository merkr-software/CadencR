import { translateUi } from "@/lib/i18n/ui";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import {
  desktopBridge,
  type BrowserFindResult,
  type BrowserTabMetadata,
} from "@/lib/desktop-bridge";

import { showBrowserError } from "./browser-errors";

export interface BrowserFindModel {
  open: boolean;
  query: string;
  pending: boolean;
  matches: number;
  activeMatchOrdinal: number;
  error: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  openFind: () => void;
  closeFind: () => void;
  setQuery: (query: string) => void;
  next: () => void;
  previous: () => void;
}

interface FindState {
  pending: boolean;
  matches: number;
  activeMatchOrdinal: number;
  error: string | null;
}

interface ActiveFindRequest {
  tabId: string;
  token: string;
}

const EMPTY_FIND_STATE: FindState = {
  pending: false,
  matches: 0,
  activeMatchOrdinal: 0,
  error: null,
};

export function useBrowserFind(activeTab: BrowserTabMetadata | null): BrowserFindModel {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [findState, setFindState] = useState<FindState>(EMPTY_FIND_STATE);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeTabRef = useRef(activeTab);
  const activeRequestRef = useRef<ActiveFindRequest | null>(null);
  activeTabRef.current = activeTab;

  const runFind = useCallback((text: string, forward: boolean, findNext: boolean): void => {
    const tab = activeTabRef.current;
    if (!tab || text.length === 0) return;
    const token = globalThis.crypto.randomUUID();
    activeRequestRef.current = { tabId: tab.id, token };
    setFindState((current) => ({ ...current, pending: true, error: null }));
    void desktopBridge
      .findInBrowserTab(tab.id, { requestToken: token, query: text, forward, findNext })
      .catch((error: unknown) => {
        if (activeRequestRef.current?.token !== token) return;
        setFindState({
          ...EMPTY_FIND_STATE,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, []);

  useFindResultSubscription(activeRequestRef, setFindState);

  const activeTabId = activeTab?.id ?? null;
  const activeTabUrl = activeTab?.url ?? null;
  const activeTabLoading = activeTab?.loading ?? false;
  useEffect(() => {
    if (!open) return;
    if (!activeTabId || query.length === 0) {
      activeRequestRef.current = null;
      setFindState(EMPTY_FIND_STATE);
      if (activeTabId) stopBrowserFind(activeTabId, false);
      return;
    }
    if (activeTabLoading) {
      activeRequestRef.current = null;
      setFindState({ ...EMPTY_FIND_STATE, pending: true });
      return;
    }
    // A query edit, tab switch, or main-frame navigation starts a fresh native
    // session. Follow-up Enter presses use `findNext: false` below.
    runFind(query, true, true);
  }, [activeTabId, activeTabLoading, activeTabUrl, open, query, runFind]);

  useEffect(() => {
    if (!activeTabId) return;
    return () => {
      if (activeRequestRef.current?.tabId === activeTabId) activeRequestRef.current = null;
      stopBrowserFind(activeTabId, false);
    };
  }, [activeTabId]);

  // Focus only after React has committed the conditional toolbar and attached
  // its input ref. A single requestAnimationFrame can run before that commit
  // under concurrent rendering, leaving focus on the renderer body.
  useLayoutEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  const openFind = useCallback((): void => {
    // Repeated Find while the toolbar is already mounted should still reclaim
    // focus and select the current query.
    inputRef.current?.focus();
    inputRef.current?.select();
    setOpen(true);
  }, []);
  const closeFind = useCallback((): void => {
    const tabId = activeTabRef.current?.id;
    activeRequestRef.current = null;
    setOpen(false);
    setFindState(EMPTY_FIND_STATE);
    if (!tabId) return;
    stopBrowserFind(tabId, true);
  }, []);
  const next = useCallback((): void => runFind(query, true, false), [query, runFind]);
  const previous = useCallback((): void => runFind(query, false, false), [query, runFind]);

  return useMemo(
    () => ({
      open,
      query,
      ...findState,
      inputRef,
      openFind,
      closeFind,
      setQuery,
      next,
      previous,
    }),
    [closeFind, findState, next, open, openFind, previous, query],
  );
}

function useFindResultSubscription(
  activeRequestRef: RefObject<ActiveFindRequest | null>,
  setFindState: (state: FindState) => void,
): void {
  useEffect(() => {
    return desktopBridge.onBrowserFindResult((result: BrowserFindResult) => {
      const activeRequest = activeRequestRef.current;
      if (
        !activeRequest ||
        result.tabId !== activeRequest.tabId ||
        result.requestToken !== activeRequest.token
      ) {
        return;
      }
      setFindState({
        pending: !result.finalUpdate,
        matches: result.matches,
        activeMatchOrdinal: result.activeMatchOrdinal,
        error: null,
      });
    });
  }, [activeRequestRef, setFindState]);
}

function stopBrowserFind(tabId: string, keepSelection: boolean): void {
  void desktopBridge.stopFindingInBrowserTab(tabId, keepSelection).catch((error: unknown) => {
    showBrowserError(
      error,
      keepSelection
        ? translateUi(
            "workspace.tools.useBrowserFind.couldNotClosePageSearch",
            "Could not close page search",
          )
        : translateUi(
            "workspace.tools.useBrowserFind.couldNotClearPageSearch",
            "Could not clear page search",
          ),
    );
  });
}

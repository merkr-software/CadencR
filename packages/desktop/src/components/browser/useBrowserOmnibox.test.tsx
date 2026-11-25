import { uiI18n } from "@/lib/i18n/ui";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_BROWSER_LIBRARY_QUERY_LENGTH,
  MAX_BROWSER_LIBRARY_URL_LENGTH,
  type BrowserBookmark,
  type BrowserLibraryChange,
  type BrowserTabMetadata,
} from "@/shared/browser-types";
import { useBrowserOmnibox } from "./useBrowserOmnibox";

const { bridgeMocks, libraryListeners } = vi.hoisted(() => ({
  libraryListeners: new Set<(change: BrowserLibraryChange) => void>(),
  bridgeMocks: {
    queryBrowserOmnibox: vi.fn(),
    getBrowserBookmark: vi.fn(),
    setBrowserBookmark: vi.fn(),
    removeBrowserHistoryEntry: vi.fn(),
    clearBrowserHistory: vi.fn(),
    onBrowserLibraryChanged: vi.fn((listener: (change: BrowserLibraryChange) => void) => {
      libraryListeners.add(listener);
      return () => libraryListeners.delete(listener);
    }),
  },
}));

vi.mock("@/lib/desktop-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/desktop-bridge")>();
  return { ...actual, desktopBridge: { ...actual.desktopBridge, ...bridgeMocks } };
});

const EMPTY_LIBRARY = { bookmarkCount: 0, bookmarks: [], historyCount: 0, history: [] };

function tab(id: string, url: string): BrowserTabMetadata {
  return {
    id,
    url,
    title: id,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    sessionProfileId: "default",
    isActive: true,
    devToolsOpen: false,
    pinned: false,
    suspended: false,
    scopeId: 1,
    zoomPercent: 100,
    responsive: {
      enabled: false,
      preset: "mobile",
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
      touch: true,
      colorScheme: "system",
      status: "ready",
    },
  };
}

function bookmark(url: string): BrowserBookmark {
  return {
    id: `bookmark-${url}`,
    url,
    title: url,
    createdAt: "2026-09-07T12:00:00.000Z",
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise?.(value) };
}

beforeEach(() => {
  vi.clearAllMocks();
  libraryListeners.clear();
  bridgeMocks.queryBrowserOmnibox.mockResolvedValue(EMPTY_LIBRARY);
  bridgeMocks.getBrowserBookmark.mockResolvedValue(null);
  bridgeMocks.setBrowserBookmark.mockResolvedValue(null);
  bridgeMocks.removeBrowserHistoryEntry.mockResolvedValue(undefined);
  bridgeMocks.clearBrowserHistory.mockResolvedValue(undefined);
});

afterEach(() =>
  act(async () => {
    await uiI18n.changeLanguage("en");
  }),
);

it("localizes an in-flight rejection and existing fallback without replaying library work", async () => {
  const activeTab = tab("normal", "https://example.com");
  const deletion = Promise.withResolvers<void>();
  bridgeMocks.removeBrowserHistoryEntry.mockReturnValueOnce(deletion.promise);
  const { result } = renderHook(() =>
    useBrowserOmnibox({
      enabled: true,
      query: "",
      tabs: [activeTab],
      activeTab,
      searchEngine: "google",
    }),
  );
  await waitFor(() => expect(bridgeMocks.queryBrowserOmnibox).toHaveBeenCalledTimes(1));
  let removing: Promise<void>;
  act(() => {
    removing = result.current.removeHistoryEntry("entry");
  });
  expect(result.current.mutationPending).toBe(true);

  await act(async () => {
    await uiI18n.changeLanguage("cimode");
  });
  await act(async () => {
    deletion.reject(null);
    await removing;
  });
  expect(result.current.error).toBe(
    "workspace.tools.useBrowserOmnibox.couldNotDeleteThisHistoryEntry",
  );

  await act(async () => {
    await uiI18n.changeLanguage("en");
  });
  expect(result.current.error).toBe("Could not delete this history entry.");
  expect(bridgeMocks.queryBrowserOmnibox).toHaveBeenCalledTimes(1);
  expect(bridgeMocks.getBrowserBookmark).toHaveBeenCalledTimes(1);
  expect(bridgeMocks.onBrowserLibraryChanged).toHaveBeenCalledTimes(2);
  expect(bridgeMocks.removeBrowserHistoryEntry).toHaveBeenCalledTimes(1);
});

describe("useBrowserOmnibox bookmark authority", () => {
  it("bounds only the local lookup payload for a long address", async () => {
    const longQuery = `https://example.com/${"a".repeat(MAX_BROWSER_LIBRARY_QUERY_LENGTH)}`;
    renderHook(() =>
      useBrowserOmnibox({
        enabled: true,
        query: longQuery,
        tabs: [],
        activeTab: null,
        searchEngine: "google",
      }),
    );

    await waitFor(() =>
      expect(bridgeMocks.queryBrowserOmnibox).toHaveBeenCalledWith(
        longQuery.slice(0, MAX_BROWSER_LIBRARY_QUERY_LENGTH),
        8,
      ),
    );
  });

  it("does not query or mutate bookmarks for an address outside persistence limits", async () => {
    const active = tab(
      "tab-long",
      `https://example.com/${"a".repeat(MAX_BROWSER_LIBRARY_URL_LENGTH)}`,
    );
    const { result } = renderHook(() =>
      useBrowserOmnibox({
        enabled: false,
        query: active.url,
        tabs: [active],
        activeTab: active,
        searchEngine: "google",
      }),
    );

    expect(result.current.isBookmarked).toBe(false);
    expect(result.current.mutationPending).toBe(false);
    expect(bridgeMocks.getBrowserBookmark).not.toHaveBeenCalled();
    await act(() => result.current.toggleBookmark());
    expect(bridgeMocks.setBrowserBookmark).not.toHaveBeenCalled();
  });

  it("uses an exact lookup rather than the capped suggestion query for bookmark status", async () => {
    const active = tab("tab-a", "https://example.com/exact");
    bridgeMocks.getBrowserBookmark.mockResolvedValue(bookmark(active.url));
    const { result } = renderHook(() =>
      useBrowserOmnibox({
        enabled: false,
        query: "",
        tabs: [active],
        activeTab: active,
        searchEngine: "google",
      }),
    );

    await waitFor(() => expect(result.current.isBookmarked).toBe(true));
    expect(bridgeMocks.getBrowserBookmark).toHaveBeenCalledWith(active.url);
    expect(bridgeMocks.queryBrowserOmnibox).not.toHaveBeenCalled();
  });

  it("ignores a late bookmark lookup after the active tab changes", async () => {
    const first = tab("tab-a", "https://example.com/a");
    const second = tab("tab-b", "https://example.com/b");
    const firstRead = deferred<BrowserBookmark | null>();
    const secondRead = deferred<BrowserBookmark | null>();
    bridgeMocks.getBrowserBookmark
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(secondRead.promise);
    const { result, rerender } = renderHook(
      ({ activeTab }) =>
        useBrowserOmnibox({
          enabled: false,
          query: "",
          tabs: [activeTab],
          activeTab,
          searchEngine: "google",
        }),
      { initialProps: { activeTab: first } },
    );

    rerender({ activeTab: second });
    await act(() => {
      secondRead.resolve(null);
      return secondRead.promise;
    });
    await act(() => {
      firstRead.resolve(bookmark(first.url));
      return firstRead.promise;
    });
    expect(result.current.isBookmarked).toBe(false);
  });

  it("does not let an initial read overwrite a confirmed bookmark mutation", async () => {
    const active = tab("tab-a", "https://example.com/a");
    const initialRead = deferred<BrowserBookmark | null>();
    bridgeMocks.getBrowserBookmark.mockReturnValue(initialRead.promise);
    bridgeMocks.setBrowserBookmark.mockResolvedValue(bookmark(active.url));
    const { result } = renderHook(() =>
      useBrowserOmnibox({
        enabled: false,
        query: "",
        tabs: [active],
        activeTab: active,
        searchEngine: "google",
      }),
    );

    await act(() => result.current.toggleBookmark());
    await act(() => {
      initialRead.resolve(null);
      return initialRead.promise;
    });
    expect(result.current.isBookmarked).toBe(true);
  });

  it("guards bookmark mutations against same-tick double activation", async () => {
    const active = tab("tab-a", "https://example.com/a");
    const mutation = deferred<BrowserBookmark | null>();
    bridgeMocks.setBrowserBookmark.mockReturnValue(mutation.promise);
    const { result } = renderHook(() =>
      useBrowserOmnibox({
        enabled: false,
        query: "",
        tabs: [active],
        activeTab: active,
        searchEngine: "google",
      }),
    );
    await waitFor(() => expect(result.current.mutationPending).toBe(false));

    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    act(() => {
      first = result.current.toggleBookmark();
      second = result.current.toggleBookmark();
    });
    expect(bridgeMocks.setBrowserBookmark).toHaveBeenCalledTimes(1);
    await act(() => {
      mutation.resolve(bookmark(active.url));
      return Promise.all([first, second]);
    });
  });

  it("refreshes matching bookmark state in another mounted consumer", async () => {
    const active = tab("tab-a", "https://example.com/shared");
    bridgeMocks.getBrowserBookmark.mockResolvedValue(null);
    const first = renderHook(() =>
      useBrowserOmnibox({
        enabled: false,
        query: "",
        tabs: [active],
        activeTab: active,
        searchEngine: "google",
      }),
    );
    const second = renderHook(() =>
      useBrowserOmnibox({
        enabled: false,
        query: "",
        tabs: [active],
        activeTab: active,
        searchEngine: "google",
      }),
    );
    await waitFor(() => expect(bridgeMocks.getBrowserBookmark).toHaveBeenCalledTimes(2));

    bridgeMocks.setBrowserBookmark.mockResolvedValue(bookmark(active.url));
    bridgeMocks.getBrowserBookmark.mockResolvedValue(bookmark(active.url));
    await act(async () => {
      const mutation = first.result.current.toggleBookmark();
      for (const listener of libraryListeners) listener({ kind: "bookmark", url: active.url });
      await mutation;
    });

    await waitFor(() => expect(second.result.current.isBookmarked).toBe(true));
  });

  it("clears a bookmark lookup error after switching to a private tab", async () => {
    const normal = tab("normal", "https://example.com/failure");
    const privateTab = { ...tab("private", "about:blank"), sessionProfileId: "fresh" };
    bridgeMocks.getBrowserBookmark.mockRejectedValueOnce(new Error("read failed"));
    const { result, rerender } = renderHook(
      ({ activeTab }) =>
        useBrowserOmnibox({
          enabled: false,
          query: "",
          tabs: [activeTab],
          activeTab,
          searchEngine: "google",
        }),
      { initialProps: { activeTab: normal } },
    );
    await waitFor(() => expect(result.current.error).toBe("read failed"));
    expect(result.current.mutationPending).toBe(false);

    bridgeMocks.getBrowserBookmark.mockResolvedValue(bookmark(normal.url));
    act(() => {
      for (const listener of libraryListeners) listener({ kind: "bookmark", url: normal.url });
    });
    await waitFor(() => expect(result.current.isBookmarked).toBe(true));

    rerender({ activeTab: privateTab });
    await waitFor(() => expect(result.current.error).toBeNull());
    expect(bridgeMocks.getBrowserBookmark).toHaveBeenCalledTimes(2);
  });
});

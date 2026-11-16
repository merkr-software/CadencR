import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserAddressBar, type BrowserAddressBarProps } from "./BrowserAddressBar";
import { MAX_BROWSER_LIBRARY_URL_LENGTH, type BrowserTabMetadata } from "@/shared/browser-types";

const bridgeMocks = vi.hoisted(() => ({
  queryBrowserOmnibox: vi.fn(),
  getBrowserBookmark: vi.fn(),
  setBrowserBookmark: vi.fn(),
  removeBrowserHistoryEntry: vi.fn(),
  clearBrowserHistory: vi.fn(),
  onBrowserLibraryChanged: vi.fn(() => () => undefined),
}));
const searchSettingMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/desktop-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/desktop-bridge")>();
  return { ...actual, desktopBridge: { ...actual.desktopBridge, ...bridgeMocks } };
});

vi.mock("@/lib/browser-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/browser-settings")>();
  return { ...actual, useBrowserSearchEngine: searchSettingMock };
});

interface SetupResult {
  onActivateTab: ReturnType<typeof vi.fn>;
  onNavigate: ReturnType<typeof vi.fn>;
  onUrlChange: ReturnType<typeof vi.fn>;
}

function activeTab(sessionProfileId = "default"): BrowserTabMetadata {
  return {
    id: "active-tab",
    title: "Example",
    url: "https://example.com/",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    sessionProfileId,
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

function setup(overrides: Partial<BrowserAddressBarProps> = {}): SetupResult {
  const onActivateTab = vi.fn();
  const onNavigate = vi.fn();
  const onUrlChange = vi.fn();
  const props: BrowserAddressBarProps = {
    urlInput: "loc",
    pending: false,
    activeTab: null,
    tabs: [],
    inputRef: createRef<HTMLInputElement>(),
    onUrlChange,
    onUrlEditingChange: vi.fn(),
    onNavigate,
    onActivateTab,
    onBack: vi.fn(),
    onForward: vi.fn(),
    onReload: vi.fn(),
    onStop: vi.fn(),
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onZoomReset: vi.fn(),
    onFind: vi.fn(),
    onDevTools: vi.fn(),
    onOpenExternal: vi.fn(),
    onAddComment: vi.fn(),
    onResponsive: vi.fn(),
    onDownloads: vi.fn(),
    ...overrides,
  };
  render(<BrowserAddressBar {...props} />);
  return { onActivateTab, onNavigate, onUrlChange };
}

beforeEach(() => {
  vi.clearAllMocks();
  searchSettingMock.mockReturnValue({ engine: "google", isLoading: false });
  bridgeMocks.queryBrowserOmnibox.mockResolvedValue({
    bookmarkCount: 0,
    bookmarks: [],
    historyCount: 1,
    history: [
      {
        id: "history-local",
        title: "Local dev server",
        url: "http://localhost:5173/",
        visitedAt: "2026-09-07T12:00:00.000Z",
      },
    ],
  });
  bridgeMocks.getBrowserBookmark.mockResolvedValue(null);
  bridgeMocks.setBrowserBookmark.mockResolvedValue(null);
  bridgeMocks.removeBrowserHistoryEntry.mockResolvedValue(undefined);
  bridgeMocks.clearBrowserHistory.mockResolvedValue(undefined);
});

describe("BrowserAddressBar omnibox interactions", () => {
  it("selects the whole URL on first pointer focus but leaves later caret edits alone", () => {
    setup({ urlInput: "https://example.com/path" });
    const input = screen.getByLabelText<HTMLInputElement>("Browser URL");

    expect(fireEvent.pointerDown(input)).toBe(false);
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);

    input.setSelectionRange(8, 8);
    expect(fireEvent.pointerDown(input)).toBe(true);
    expect(input.selectionStart).toBe(8);
    expect(input.selectionEnd).toBe(8);
  });

  it("submits with Enter without rendering a redundant Go button", async () => {
    const user = userEvent.setup();
    const { onNavigate } = setup({ urlInput: "example.com" });
    expect(screen.queryByRole("button", { name: "Go" })).not.toBeInTheDocument();
    await user.click(screen.getByLabelText("Browser URL"));
    await user.keyboard("{Enter}");
    expect(onNavigate).toHaveBeenCalledWith("https://example.com/");
  });

  it("navigates to a local history suggestion on click", async () => {
    const user = userEvent.setup();
    const { onNavigate } = setup();
    await user.click(screen.getByLabelText("Browser URL"));
    await user.click(await screen.findByText("Local dev server"));
    expect(onNavigate).toHaveBeenCalledWith("http://localhost:5173/");
  });

  it("selects a suggestion on pointer down before blur can close the list", async () => {
    const user = userEvent.setup();
    const { onNavigate } = setup();
    const input = screen.getByLabelText("Browser URL");
    await user.click(input);
    const option = await screen.findByText("Local dev server");
    fireEvent.pointerDown(option);
    fireEvent.blur(input);
    expect(onNavigate).toHaveBeenCalledWith("http://localhost:5173/");
  });

  it("keeps history controls keyboard reachable after the input loses focus", async () => {
    const user = userEvent.setup();
    setup();
    const input = screen.getByLabelText("Browser URL");
    await user.click(input);
    const deleteButton = await screen.findByRole("button", { name: /delete local dev server/i });
    deleteButton.focus();
    fireEvent.blur(input, { relatedTarget: deleteButton });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(deleteButton).toHaveFocus();
  });

  it("submits text to the configured search engine only after Enter", async () => {
    const user = userEvent.setup();
    const { onNavigate } = setup({ urlInput: "how to use foo.bar" });
    expect(onNavigate).not.toHaveBeenCalled();
    await user.click(screen.getByLabelText("Browser URL"));
    await user.keyboard("{Enter}");
    expect(onNavigate).toHaveBeenCalledWith(
      "https://www.google.com/search?q=how%20to%20use%20foo.bar",
    );
  });

  it("shows a visible error and never searches an explicit blocked scheme", async () => {
    const user = userEvent.setup();
    const { onNavigate } = setup({ urlInput: "javascript:alert(1)" });
    await user.click(screen.getByLabelText("Browser URL"));
    await user.keyboard("{Enter}");
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("javascript: addresses is blocked");
  });

  it("waits for the saved search engine before submitting terms but still opens URLs", async () => {
    const user = userEvent.setup();
    searchSettingMock.mockReturnValue({ engine: "google", isLoading: true });
    const search = setup({ urlInput: "private query" });
    await user.click(screen.getByLabelText("Browser URL"));
    await user.keyboard("{Enter}");
    expect(search.onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "search engine preference is still loading",
    );

    cleanup();
    const url = setup({ urlInput: "example.com" });
    await user.click(screen.getByLabelText("Browser URL"));
    await user.keyboard("{Enter}");
    expect(url.onNavigate).toHaveBeenCalledWith("https://example.com/");
  });

  it("activates an already-open scoped tab instead of navigating again", async () => {
    const user = userEvent.setup();
    const { onActivateTab, onNavigate } = setup({
      urlInput: "docs",
      tabs: [
        {
          id: "tab-docs",
          title: "Project docs",
          url: "https://docs.example.com/",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          sessionProfileId: "fresh",
          isActive: false,
          devToolsOpen: false,
          pinned: false,
          suspended: false,
          scopeId: 4,
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
        },
      ],
    });
    await user.click(screen.getByLabelText("Browser URL"));
    await user.click(await screen.findByText("Project docs"));
    expect(onActivateTab).toHaveBeenCalledWith("tab-docs");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("keeps bookmark failures visible after the address popup closes", async () => {
    const user = userEvent.setup();
    bridgeMocks.setBrowserBookmark.mockRejectedValue(new Error("Disk is read-only"));
    setup({ activeTab: activeTab(), tabs: [activeTab()] });
    const bookmarkButton = await screen.findByRole("button", { name: "Bookmark this page" });
    await waitFor(() => expect(bookmarkButton).toBeEnabled());
    await user.click(bookmarkButton);
    expect(await screen.findByRole("alert")).toHaveTextContent("Disk is read-only");
  });

  it("disables bookmarks in private tabs with an explicit explanation", () => {
    const privateTab = activeTab("fresh");
    setup({ activeTab: privateTab, tabs: [privateTab] });
    expect(screen.getByRole("button", { name: "Bookmark this page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Bookmark this page" })).toHaveAttribute(
      "title",
      expect.stringMatching(/private tabs/i),
    );
  });

  it("keeps long addresses navigable while explaining why they cannot be bookmarked", async () => {
    const user = userEvent.setup();
    const longUrl = `https://example.com/${"a".repeat(MAX_BROWSER_LIBRARY_URL_LENGTH)}`;
    const longTab = { ...activeTab(), url: longUrl };
    const { onNavigate } = setup({ urlInput: longUrl, activeTab: longTab, tabs: [longTab] });
    const bookmarkButton = screen.getByRole("button", { name: "Bookmark this page" });

    expect(bookmarkButton).toBeDisabled();
    expect(bookmarkButton).toHaveAttribute("title", expect.stringMatching(/too long.*2048/i));
    expect(bridgeMocks.getBrowserBookmark).not.toHaveBeenCalled();
    await user.click(screen.getByLabelText("Browser URL"));
    await user.keyboard("{Enter}");
    expect(onNavigate).toHaveBeenCalledWith(longUrl);
  });

  it("collapses secondary actions before the URL field and keeps compact zoom actions accessible", async () => {
    const user = userEvent.setup();
    const active = activeTab();
    const onZoomOut = vi.fn();
    setup({ activeTab: active, tabs: [active], onZoomOut });

    expect(screen.getByRole("button", { name: "Find in page" }).parentElement).toHaveClass(
      "@max-[50rem]:hidden",
    );
    expect(screen.getByRole("button", { name: "Zoom out" }).parentElement).toHaveClass(
      "@max-[28rem]:hidden",
    );
    const moreActions = screen.getByRole("button", { name: "More Browser actions" });
    expect(moreActions).toHaveClass("@max-[50rem]:inline-flex");

    await user.click(moreActions);
    const compactZoomOut = await screen.findByRole("menuitem", { name: "Zoom out" });
    expect(screen.getByRole("menuitem", { name: /reset zoom.*100%/i })).toBeInTheDocument();
    await user.click(compactZoomOut);
    expect(onZoomOut).toHaveBeenCalledOnce();
  });

  it("opens Downloads from the overflow menu, which no longer lists Add comment", async () => {
    const user = userEvent.setup();
    const active = activeTab();
    const onDownloads = vi.fn();
    setup({ activeTab: active, tabs: [active], onDownloads });

    await user.click(screen.getByRole("button", { name: "More Browser actions" }));
    expect(screen.queryByRole("menuitem", { name: "Add comment" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("menuitem", { name: /Downloads/ }));
    await waitFor(() => expect(onDownloads).toHaveBeenCalledOnce());
  });

  it("keeps the overflow menu usable for Downloads without an active tab", async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole("button", { name: "More Browser actions" }));
    expect(await screen.findByRole("menuitem", { name: /Downloads/ })).toBeEnabled();
    for (const name of ["Find in page", "Responsive mode", /DevTools/]) {
      expect(screen.getByRole("menuitem", { name })).toHaveAttribute("aria-disabled", "true");
    }
  });

  it("hands overflow Find focus to its target after the menu releases focus", async () => {
    const user = userEvent.setup();
    const active = activeTab();
    const findTarget = createRef<HTMLInputElement>();
    setup({
      activeTab: active,
      tabs: [active],
      onFind: () => findTarget.current?.focus(),
    });
    render(<input ref={findTarget} aria-label="Compact find target" />);

    const moreActions = screen.getByRole("button", { name: "More Browser actions" });
    await user.click(moreActions);
    await user.click(await screen.findByRole("menuitem", { name: "Find in page" }));

    await waitFor(() => expect(screen.getByLabelText("Compact find target")).toHaveFocus());
    expect(moreActions).not.toHaveFocus();
  });

  it("reports overlay state while the local suggestion panel is open", async () => {
    const user = userEvent.setup();
    const onSuggestionOverlayOpenChange = vi.fn();
    setup({ onSuggestionOverlayOpenChange });
    await user.click(screen.getByLabelText("Browser URL"));
    await waitFor(() => expect(onSuggestionOverlayOpenChange).toHaveBeenLastCalledWith(true));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });
});

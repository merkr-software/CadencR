import {
  memo,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import type { BrowserTabMetadata } from "@/lib/desktop-bridge";
import { resolveOmniboxInput, type BrowserOmniboxSuggestion } from "@/lib/browser-omnibox";
import { useBrowserSearchEngine, type BrowserSearchEngine } from "@/lib/browser-settings";
import { MAX_BROWSER_LIBRARY_URL_LENGTH } from "@/shared/browser-types";
import { isHttpBrowserUrl } from "@/shared/browser-url";
import { BrowserNavControls, BrowserUrlField } from "./BrowserAddressBarParts";
import { BrowserToolbarActions } from "./BrowserToolbarActions";
import { isPersistentTab, useBrowserOmnibox } from "./useBrowserOmnibox";

export interface BrowserAddressBarProps {
  urlInput: string;
  pending: boolean;
  activeTab: BrowserTabMetadata | null;
  tabs: BrowserTabMetadata[];
  inputRef: RefObject<HTMLInputElement | null>;
  onUrlChange: (value: string) => void;
  onUrlEditingChange: (editing: boolean) => void;
  onNavigate: (url: string) => void;
  onActivateTab: (tabId: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onFind: () => void;
  onDevTools: () => void;
  onOpenExternal: () => void;
  onAddComment: () => void;
  onResponsive: () => void;
  onDownloads: () => void;
  onSuggestionOverlayOpenChange?: (open: boolean) => void;
  siteControl?: ReactNode;
  downloadsControl?: ReactNode;
}

function BrowserAddressBarImpl(props: BrowserAddressBarProps): ReactElement {
  const { onUrlEditingChange, onUrlChange, onActivateTab, onNavigate, urlInput } = props;
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const [inputError, setInputError] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [clearConfirmationOpen, setClearConfirmationOpen] = useState(false);
  const listboxId = useId();
  const { engine, isLoading: engineLoading } = useBrowserSearchEngine();
  const omnibox = useBrowserOmnibox({
    enabled: open,
    query: props.urlInput,
    tabs: props.tabs,
    activeTab: props.activeTab,
    searchEngine: engine,
  });
  const suggestions = visibleSuggestions(omnibox.suggestions, engineLoading);
  const dismissOmniboxError = omnibox.dismissError;
  const error = inputError ?? omnibox.error;
  useSuggestionOverlay(
    props.onSuggestionOverlayOpenChange,
    open || actionsOpen || clearConfirmationOpen,
  );

  const closePanel = useCallback((): void => {
    setOpen(false);
    setHighlighted(-1);
  }, []);
  const openPanel = useCallback((): void => {
    setOpen(true);
    setHighlighted(-1);
  }, []);
  const dismissError = useCallback((): void => {
    setInputError(null);
    dismissOmniboxError();
  }, [dismissOmniboxError]);
  const selectSuggestion = useCallback(
    (suggestion: Pick<BrowserOmniboxSuggestion, "url" | "tabId">): void => {
      onUrlEditingChange(false);
      onUrlChange(suggestion.url);
      if (suggestion.tabId) onActivateTab(suggestion.tabId);
      else onNavigate(suggestion.url);
      closePanel();
    },
    [closePanel, onActivateTab, onNavigate, onUrlChange, onUrlEditingChange],
  );
  const submit = useCallback(
    (event: FormEvent<HTMLFormElement>): void => {
      event.preventDefault();
      try {
        const resolution = resolveSubmission(urlInput, engine, engineLoading);
        dismissError();
        selectSuggestion(resolution);
      } catch (submitError) {
        setInputError(errorMessage(submitError));
        setOpen(true);
      }
    },
    [dismissError, engine, engineLoading, selectSuggestion, urlInput],
  );
  const { handleChange, handleKeyDown } = useAddressInputHandlers({
    closePanel,
    highlighted,
    open,
    openPanel,
    onUrlChange: props.onUrlChange,
    selectSuggestion,
    setHighlighted,
    setOpen,
    suggestions,
  });

  return renderAddressBar({
    ...props,
    activeOptionId: highlighted >= 0 ? `${listboxId}-option-${highlighted}` : undefined,
    bookmarkDisabledReason: bookmarkDisabledReason(props.activeTab),
    clearConfirmationOpen,
    closePanel,
    dismissError,
    engineLoading,
    error,
    handleChange,
    handleKeyDown,
    highlighted,
    listboxId,
    omnibox,
    openPanel,
    panelOpen: open,
    selectSuggestion,
    setActionsOpen,
    setClearConfirmationOpen,
    setHighlighted,
    submit,
    suggestions,
  });
}

function resolveSubmission(input: string, engine: BrowserSearchEngine, loading: boolean) {
  const resolution = resolveOmniboxInput(input, engine);
  if (resolution.kind === "search" && loading) {
    throw new Error("Your search engine preference is still loading. Try again in a moment.");
  }
  return resolution;
}

interface AddressInputHandlerArgs extends AddressKeyDownArgs {
  onUrlChange: (value: string) => void;
  setOpen: (open: boolean) => void;
}

function useAddressInputHandlers(args: AddressInputHandlerArgs): {
  handleChange: (value: string) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
} {
  const { onUrlChange, setOpen, setHighlighted } = args;
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => handleAddressKeyDown(event, args),
    [
      args.closePanel,
      args.highlighted,
      args.open,
      args.openPanel,
      args.selectSuggestion,
      args.setHighlighted,
      args.suggestions,
    ],
  );
  const handleChange = useCallback(
    (value: string): void => {
      onUrlChange(value);
      setOpen(true);
      setHighlighted(-1);
    },
    [onUrlChange, setHighlighted, setOpen],
  );
  return useMemo(() => ({ handleChange, handleKeyDown }), [handleChange, handleKeyDown]);
}

function visibleSuggestions(
  suggestions: BrowserOmniboxSuggestion[],
  searchEngineLoading: boolean,
): BrowserOmniboxSuggestion[] {
  return searchEngineLoading
    ? suggestions.filter((suggestion) => suggestion.source !== "search")
    : suggestions;
}

interface AddressBarViewProps extends BrowserAddressBarProps {
  activeOptionId: string | undefined;
  bookmarkDisabledReason: string | null;
  clearConfirmationOpen: boolean;
  closePanel: () => void;
  dismissError: () => void;
  engineLoading: boolean;
  error: string | null;
  handleChange: (value: string) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  highlighted: number;
  listboxId: string;
  omnibox: ReturnType<typeof useBrowserOmnibox>;
  openPanel: () => void;
  panelOpen: boolean;
  selectSuggestion: (suggestion: BrowserOmniboxSuggestion) => void;
  setActionsOpen: (open: boolean) => void;
  setClearConfirmationOpen: (open: boolean) => void;
  setHighlighted: (index: number) => void;
  submit: (event: FormEvent<HTMLFormElement>) => void;
  suggestions: BrowserOmniboxSuggestion[];
}

function renderAddressBar(view: AddressBarViewProps): ReactElement {
  return (
    <>
      <div className="@container relative">
        <form className="relative flex items-center gap-1.5" onSubmit={view.submit}>
          <BrowserNavControls
            activeTab={view.activeTab}
            onBack={view.onBack}
            onForward={view.onForward}
            onReload={view.onReload}
            onStop={view.onStop}
          />
          <BrowserUrlField
            inputRef={view.inputRef}
            urlInput={view.urlInput}
            panelOpen={view.panelOpen}
            listboxId={view.listboxId}
            activeOptionId={view.activeOptionId}
            suggestions={view.suggestions}
            highlighted={view.highlighted}
            isQuerying={view.omnibox.isQuerying || view.engineLoading}
            error={view.error}
            historyCount={view.omnibox.historyCount}
            isBookmarked={view.omnibox.isBookmarked}
            bookmarkPending={view.omnibox.mutationPending}
            bookmarkDisabledReason={view.bookmarkDisabledReason}
            onChange={view.handleChange}
            onOpenPanel={view.openPanel}
            onClosePanel={view.closePanel}
            onEditingChange={view.onUrlEditingChange}
            onKeyDown={view.handleKeyDown}
            onSelectSuggestion={view.selectSuggestion}
            onHighlightSuggestion={view.setHighlighted}
            onRemoveHistory={(id) => void view.omnibox.removeHistoryEntry(id)}
            onClearHistory={() => view.setClearConfirmationOpen(true)}
            onToggleBookmark={() => void view.omnibox.toggleBookmark()}
            onDismissError={view.dismissError}
            siteControl={view.siteControl}
          />
          <BrowserToolbarActions
            activeTab={view.activeTab}
            onZoomIn={view.onZoomIn}
            onZoomOut={view.onZoomOut}
            onZoomReset={view.onZoomReset}
            onFind={view.onFind}
            onDevTools={view.onDevTools}
            onOpenExternal={view.onOpenExternal}
            onAddComment={view.onAddComment}
            onResponsive={view.onResponsive}
            onDownloads={view.onDownloads}
            onMenuOpenChange={view.setActionsOpen}
          />
          {view.downloadsControl}
        </form>
        {view.error && !view.panelOpen ? (
          <div
            role="alert"
            className="mt-1 rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive"
          >
            {view.error}
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={view.clearConfirmationOpen}
        onOpenChange={view.setClearConfirmationOpen}
        title="Clear Browser history?"
        description={historyClearDescription(view.omnibox.historyCount)}
        confirmText="Clear history"
        variant="destructive"
        busy={view.omnibox.mutationPending}
        onConfirm={view.omnibox.clearHistory}
      />
    </>
  );
}

interface AddressKeyDownArgs {
  open: boolean;
  highlighted: number;
  suggestions: BrowserOmniboxSuggestion[];
  openPanel: () => void;
  closePanel: () => void;
  selectSuggestion: (suggestion: BrowserOmniboxSuggestion) => void;
  setHighlighted: (index: number) => void;
}

function handleAddressKeyDown(
  event: KeyboardEvent<HTMLInputElement>,
  args: AddressKeyDownArgs,
): void {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!args.open) args.openPanel();
    if (args.suggestions.length === 0) return;
    const step = event.key === "ArrowDown" ? 1 : -1;
    const start = args.highlighted < 0 ? (step > 0 ? -1 : 0) : args.highlighted;
    args.setHighlighted((start + step + args.suggestions.length) % args.suggestions.length);
    return;
  }
  if (event.key === "Enter" && args.open && args.highlighted >= 0) {
    const suggestion = args.suggestions[args.highlighted];
    if (suggestion) {
      event.preventDefault();
      args.selectSuggestion(suggestion);
    }
    return;
  }
  if (event.key === "Escape" && args.open) {
    event.preventDefault();
    args.closePanel();
  }
}

function useSuggestionOverlay(
  onOpenChange: ((open: boolean) => void) | undefined,
  open: boolean,
): void {
  useLayoutEffect(() => onOpenChange?.(open), [onOpenChange, open]);
  useLayoutEffect(() => () => onOpenChange?.(false), [onOpenChange]);
}

function bookmarkDisabledReason(tab: BrowserTabMetadata | null): string | null {
  if (!tab) return "Open a web page to add a bookmark.";
  if (!isPersistentTab(tab))
    return "Bookmarks are unavailable in Private tabs so private browsing stays ephemeral.";
  if (tab.url.length > MAX_BROWSER_LIBRARY_URL_LENGTH) {
    return `This address is too long to bookmark (maximum ${MAX_BROWSER_LIBRARY_URL_LENGTH} characters).`;
  }
  return isHttpBrowserUrl(tab.url) ? null : "Only web pages can be bookmarked.";
}

function historyClearDescription(count: number): string {
  const entries =
    count > 0 ? `${count} recent history ${count === 1 ? "entry" : "entries"} and ` : "";
  return `This removes ${entries}any legacy address suggestions. Bookmarks and site data are kept.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "That address could not be opened.";
}

export const BrowserAddressBar = memo(BrowserAddressBarImpl);

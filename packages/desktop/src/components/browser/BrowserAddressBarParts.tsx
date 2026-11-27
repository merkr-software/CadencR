import { useUiTranslation } from "@/lib/i18n/ui";
import {
  type ChangeEvent,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  GlobeIcon,
  Loader2Icon,
  RefreshCwIcon,
  SquareIcon,
  StarIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { BrowserTabMetadata } from "@/lib/desktop-bridge";
import type { BrowserOmniboxSuggestion } from "@/lib/browser-omnibox";
import { BrowserOmniboxPanel } from "./BrowserOmniboxPanel";
import { cn } from "@/lib/utils";

interface BrowserNavControlsProps {
  activeTab: BrowserTabMetadata | null;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
}

export function BrowserNavControls(props: BrowserNavControlsProps): ReactElement {
  const { t } = useUiTranslation();
  const { activeTab, onBack, onForward, onReload, onStop } = props;
  const loading = activeTab?.loading === true;
  return (
    <div className="flex shrink-0 items-center rounded-md bg-muted/50 p-0.5">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={!activeTab?.canGoBack}
        onClick={onBack}
        aria-label={t("workspace.tools.browserAddressBarParts.back", "Back")}
      >
        <ArrowLeftIcon className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={!activeTab?.canGoForward}
        onClick={onForward}
        aria-label={t("workspace.tools.browserAddressBarParts.forward", "Forward")}
      >
        <ArrowRightIcon className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        disabled={!activeTab}
        onClick={loading ? onStop : onReload}
        aria-label={
          loading
            ? t("workspace.tools.browserAddressBarParts.stop", "Stop")
            : t("workspace.tools.browserAddressBarParts.reload", "Reload")
        }
      >
        {loading ? <SquareIcon className="size-4" /> : <RefreshCwIcon className="size-4" />}
      </Button>
    </div>
  );
}

export interface BrowserUrlFieldProps {
  inputRef: RefObject<HTMLInputElement | null>;
  urlInput: string;
  panelOpen: boolean;
  listboxId: string;
  activeOptionId: string | undefined;
  suggestions: BrowserOmniboxSuggestion[];
  highlighted: number;
  isQuerying: boolean;
  error: string | null;
  historyCount: number;
  isBookmarked: boolean;
  bookmarkPending: boolean;
  bookmarkDisabledReason: string | null;
  onChange: (value: string) => void;
  onOpenPanel: () => void;
  onClosePanel: () => void;
  onEditingChange: (editing: boolean) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onSelectSuggestion: (suggestion: BrowserOmniboxSuggestion) => void;
  onHighlightSuggestion: (index: number) => void;
  onRemoveHistory: (id: string) => void;
  onClearHistory: () => void;
  onToggleBookmark: () => void;
  onDismissError: () => void;
  siteControl?: ReactNode;
}

export function BrowserUrlField(props: BrowserUrlFieldProps): ReactElement {
  const { t } = useUiTranslation();
  function handleInputChange(event: ChangeEvent<HTMLInputElement>): void {
    props.onDismissError();
    props.onChange(event.target.value);
  }

  function handleInputFocus(): void {
    props.onEditingChange(true);
    props.onOpenPanel();
    props.inputRef.current?.select();
  }

  function handleInitialPointerDown(event: PointerEvent<HTMLInputElement>): void {
    if (event.button !== 0 || document.activeElement === event.currentTarget) return;
    // Prevent the pointer's default caret placement from undoing the selection
    // made when the address field first receives focus.
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.select();
  }

  function handleFocusOut(event: FocusEvent<HTMLDivElement>): void {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    props.onEditingChange(false);
    props.onClosePanel();
  }

  return (
    <div className="relative min-w-0 flex-1" onBlurCapture={handleFocusOut}>
      <div className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-transparent bg-muted px-2.5 transition-colors focus-within:border-primary focus-within:bg-card focus-within:ring-2 focus-within:ring-primary/20">
        {props.siteControl ?? (
          <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <Input
          ref={props.inputRef}
          aria-label={t("workspace.tools.browserAddressBarParts.browserUrl", "Browser URL")}
          variant="ghost"
          role="combobox"
          aria-expanded={props.panelOpen}
          aria-controls={props.panelOpen ? props.listboxId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={props.activeOptionId}
          aria-invalid={props.error ? true : undefined}
          value={props.urlInput}
          onChange={handleInputChange}
          onFocus={handleInputFocus}
          onPointerDown={handleInitialPointerDown}
          onKeyDown={props.onKeyDown}
          placeholder={t(
            "workspace.tools.browserAddressBarParts.searchOrEnterAddress",
            "Search or enter address",
          )}
          className="h-7 flex-1 font-mono text-xs"
        />
        <BookmarkButton
          bookmarked={props.isBookmarked}
          pending={props.bookmarkPending}
          disabledReason={props.bookmarkDisabledReason}
          onToggle={props.onToggleBookmark}
        />
      </div>
      {props.panelOpen ? <BrowserOmniboxPanel {...props} /> : null}
    </div>
  );
}

function BookmarkButton({
  bookmarked,
  pending,
  disabledReason,
  onToggle,
}: {
  bookmarked: boolean;
  pending: boolean;
  disabledReason: string | null;
  onToggle: () => void;
}): ReactElement {
  const { t } = useUiTranslation();
  const label = bookmarked
    ? t("workspace.tools.browserAddressBarParts.removeBookmark", "Remove bookmark")
    : t("workspace.tools.browserAddressBarParts.bookmarkThisPage", "Bookmark this page");
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      disabled={pending || disabledReason !== null}
      aria-label={label}
      title={disabledReason ?? label}
      onClick={onToggle}
      className={cn("text-muted-foreground hover:text-foreground", bookmarked && "text-primary")}
    >
      {pending ? (
        <Loader2Icon className="size-3 animate-spin" />
      ) : (
        <StarIcon className={cn("size-3.5", bookmarked && "fill-current")} />
      )}
    </Button>
  );
}

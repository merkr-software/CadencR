import { memo, useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { ChevronDownIcon, ChevronUpIcon, SearchIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SEARCH_UI_ATTR } from "@/lib/conversation-search/highlight";

interface ConversationSearchBarProps {
  query: string;
  matchCount: number;
  activeNumber: number;
  focusNonce: number;
  onQueryChange: (next: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

/**
 * Floating find-in-conversation bar, pinned to the top-right of the agent
 * stream. Enter / Shift+Enter step through matches; Escape closes. The
 * `SEARCH_UI_ATTR` marker keeps the highlight walker from painting the bar's
 * own text.
 */
export const ConversationSearchBar = memo(function ConversationSearchBar({
  query,
  matchCount,
  activeNumber,
  focusNonce,
  onQueryChange,
  onNext,
  onPrev,
  onClose,
}: ConversationSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus + select on open and on every re-trigger of the shortcut.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [focusNonce]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (event.shiftKey) onPrev();
        else onNext();
      } else if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    },
    [onNext, onPrev, onClose],
  );

  const hasQuery = query.trim().length > 0;
  const noMatches = hasQuery && matchCount === 0;

  return (
    <div
      {...{ [SEARCH_UI_ATTR]: "" }}
      className={cn(
        "absolute right-3 top-2 z-20 flex items-center gap-1.5",
        "rounded-md border bg-popover/95 px-2 py-1 shadow-md backdrop-blur",
      )}
      role="search"
    >
      <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <Input
        ref={inputRef}
        variant="ghost"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in conversation"
        aria-label="Find in conversation"
        className="w-44"
      />
      <span
        className={cn(
          "min-w-[3.5rem] shrink-0 text-right text-xs tabular-nums",
          noMatches ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {hasQuery ? `${activeNumber}/${matchCount}` : ""}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Previous match"
        onClick={onPrev}
        disabled={matchCount === 0}
        className="text-muted-foreground"
      >
        <ChevronUpIcon className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Next match"
        onClick={onNext}
        disabled={matchCount === 0}
        className="text-muted-foreground"
      >
        <ChevronDownIcon className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Close search"
        onClick={onClose}
        className="text-muted-foreground"
      >
        <XIcon className="size-4" />
      </Button>
    </div>
  );
});

import type { KeyboardEvent, RefObject } from "react";
import { CaseSensitive, ChevronDown, ChevronUp, Regex, Search, X } from "lucide-react";
import SearchToggleButton from "../SearchToggleButton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCompactCombo } from "@/lib/shortcuts/format";

// Mirrors the input's Shift+Enter handler.
const PREVIOUS_MATCH_COMBO = formatCompactCombo(["shift", "enter"]);

interface SearchInputRowProps {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  counterLabel: string;
  hasError: boolean;
  errorTitle: string | null;
  muted: boolean;
}

export function SearchInputRow({
  inputRef,
  query,
  onQueryChange,
  onKeyDown,
  counterLabel,
  hasError,
  errorTitle,
  muted,
}: SearchInputRowProps) {
  return (
    <>
      <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <input
        ref={inputRef}
        autoFocus
        type="text"
        spellCheck={false}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Find"
        title={errorTitle ?? undefined}
        className={cn(
          "w-44 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70",
          hasError && "text-destructive",
          muted && "text-muted-foreground",
        )}
        aria-invalid={hasError}
      />
      <span
        className="shrink-0 min-w-[68px] text-right text-xs tabular-nums text-muted-foreground"
        aria-live="polite"
      >
        {counterLabel}
      </span>
    </>
  );
}

interface SearchPanelControlsProps {
  disabled: boolean;
  caseSensitive: boolean;
  regex: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToggleCase: (v: boolean) => void;
  onToggleRegex: (v: boolean) => void;
  onClose: () => void;
}

export function SearchPanelControls({
  disabled,
  caseSensitive,
  regex,
  onPrev,
  onNext,
  onToggleCase,
  onToggleRegex,
  onClose,
}: SearchPanelControlsProps) {
  return (
    <div className="flex items-center gap-0.5 border-l border-border/60 pl-1">
      <Button
        variant="ghost"
        size="icon-xs"
        title={`Previous match (${PREVIOUS_MATCH_COMBO})`}
        aria-label="Previous match"
        onClick={onPrev}
        disabled={disabled}
      >
        <ChevronUp />
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        title="Next match (Enter)"
        aria-label="Next match"
        onClick={onNext}
        disabled={disabled}
      >
        <ChevronDown />
      </Button>
      <SearchToggleButton
        active={caseSensitive}
        onToggle={onToggleCase}
        title="Match case"
        icon={<CaseSensitive className="size-3.5" />}
      />
      <SearchToggleButton
        active={regex}
        onToggle={onToggleRegex}
        title="Use regular expression"
        icon={<Regex className="size-3.5" />}
      />
      <Button
        variant="ghost"
        size="icon-xs"
        title="Close (Esc)"
        aria-label="Close search"
        onClick={onClose}
      >
        <X />
      </Button>
    </div>
  );
}

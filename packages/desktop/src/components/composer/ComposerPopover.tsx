import { forwardRef, useId, type ReactNode } from "react";
import { KbdShortcut } from "@/components/KbdShortcut";
import { cn } from "@/lib/utils";

/** DOM id of option `index` inside the listbox `listId` (for aria-activedescendant). */
export function composerOptionId(listId: string, index: number): string {
  return `${listId}-opt-${index}`;
}

/** Tallest a typeahead list grows; less when the room above the prompt is short. */
export const COMPOSER_POPOVER_MAX_HEIGHT = 300;

interface ComposerPopoverProps {
  /** Listbox id — the editor's `aria-controls` / `aria-activedescendant` point here. */
  listId: string;
  /** Accessible name of the list ("Files", "Commands"…). */
  label: string;
  maxHeight?: number;
  /** Status row shown instead of options (loading, empty, error). */
  status?: ReactNode;
  /** Alert shown above the options, which stay usable (a partial failure). */
  notice?: ReactNode;
  /** Keyboard hints in the footer; defaults to navigate · insert · close. */
  hints?: ReadonlyArray<readonly [keys: readonly string[], label: string]>;
  children?: ReactNode;
}

const DEFAULT_HINTS = [
  [["up", "down"], "navigate"],
  [["enter"], "insert"],
  [["escape"], "close"],
] as const;

/**
 * Shared shell for the composer's typeahead popovers (`@` files, `@@`
 * conversations, `/` commands). One look and one keyboard contract: it rises
 * from the top edge of the composer card at the card's width, carries listbox
 * semantics for screen readers, and states its own keys in a quiet footer.
 *
 * `data-composer-popover` tells the composer's Esc handling that a popover
 * owns the next Esc (it closes before anything else can react).
 */
export const ComposerPopover = forwardRef<HTMLDivElement, ComposerPopoverProps>(
  function ComposerPopover(
    {
      listId,
      label,
      maxHeight = COMPOSER_POPOVER_MAX_HEIGHT,
      status,
      notice,
      hints = DEFAULT_HINTS,
      children,
    },
    ref,
  ) {
    return (
      <div
        data-composer-popover
        className="glass-surface flex w-full flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground"
        style={{ maxHeight }}
      >
        {notice ? (
          <div
            role="alert"
            className="flex shrink-0 items-start gap-2 border-b border-border/60 px-3 py-2 text-xs text-destructive"
          >
            {notice}
          </div>
        ) : null}
        <div
          ref={ref}
          id={listId}
          role="listbox"
          aria-label={label}
          className="min-h-0 flex-1 overflow-y-auto py-1"
        >
          {status ? (
            <div
              role="status"
              className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"
            >
              {status}
            </div>
          ) : (
            children
          )}
        </div>
        {/* Keyboard hints mean nothing to a finger: the room goes to the list. */}
        <div
          aria-hidden
          className="flex shrink-0 items-center gap-3 border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground pointer-coarse:hidden"
        >
          {hints.map(([keys, hintLabel]) => (
            <span key={hintLabel} className="inline-flex items-center gap-1">
              <KbdShortcut keys={[...keys]} variant="hint" />
              {hintLabel}
            </span>
          ))}
        </div>
      </div>
    );
  },
);

/** A labelled group of options (e.g. "Cadencr", "Skills"). */
export function ComposerPopoverGroup({ label, children }: { label: string; children: ReactNode }) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="py-0.5">
      <div id={labelId} className="px-3 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

interface ComposerPopoverOptionProps {
  listId: string;
  index: number;
  selected: boolean;
  disabled?: boolean;
  title?: string;
  onSelect: () => void;
  className?: string;
  children: ReactNode;
}

/** One selectable row. Mouse-down selects without blurring the editor. */
export function ComposerPopoverOption({
  listId,
  index,
  selected,
  disabled = false,
  title,
  onSelect,
  className,
  children,
}: ComposerPopoverOptionProps) {
  return (
    <div
      id={composerOptionId(listId, index)}
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      data-selected={selected}
      title={title}
      className={cn(
        "mx-1 flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm",
        selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/70",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
      onMouseDown={(event) => {
        event.preventDefault(); // keep the caret in the editor
        if (!disabled) onSelect();
      }}
    >
      {children}
    </div>
  );
}

/**
 * Replace-row affordances rendered below `EditorSearchPanel`'s find row when
 * the user opens Find & Replace (⌘⌥F). Split out to keep the parent panel
 * under the 400-line file limit and to isolate the replace-specific state
 * from the find-only path.
 */
import { type KeyboardEvent, type RefObject } from "react";
import { Replace, ReplaceAll } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCompactCombo } from "@/lib/shortcuts/format";
import { cn } from "@/lib/utils";

const REPLACE_ALL_COMBO = formatCompactCombo(["mod", "enter"]);

interface EditorReplaceRowProps {
  inputRef: RefObject<HTMLInputElement | null>;
  replacement: string;
  onReplacementChange: (value: string) => void;
  onReplaceOne: () => void;
  onReplaceAll: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  /** Disabled while the find input has no matches. */
  disabled: boolean;
}

export function EditorReplaceRow({
  inputRef,
  replacement,
  onReplacementChange,
  onReplaceOne,
  onReplaceAll,
  onKeyDown,
  disabled,
}: EditorReplaceRowProps) {
  return (
    <div className="flex items-center gap-1 border-t border-border/60 pt-1 mt-1">
      <Replace className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <input
        ref={inputRef}
        type="text"
        spellCheck={false}
        value={replacement}
        onChange={(e) => onReplacementChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Replace"
        aria-label="Replacement"
        className={cn(
          "w-44 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70",
        )}
      />
      <span className="shrink-0 min-w-[68px] text-right" />
      <div className="flex items-center gap-0.5 border-l border-border/60 pl-1">
        <Button
          variant="ghost"
          size="icon-xs"
          title="Replace match (Enter)"
          aria-label="Replace match"
          onClick={onReplaceOne}
          disabled={disabled}
        >
          <Replace />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          title={`Replace all (${REPLACE_ALL_COMBO})`}
          aria-label="Replace all"
          onClick={onReplaceAll}
          disabled={disabled}
        >
          <ReplaceAll />
        </Button>
      </div>
    </div>
  );
}

import { memo, useRef, useEffect, type ReactNode } from "react";
import { CircleAlertIcon, TerminalIcon, Loader2Icon, SparklesIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { CadencrLogo } from "@/components/CadencrLogo";
import { SlidingText } from "@/components/SlidingText";
import {
  isSlashCommandDisabled,
  type SlashCommand,
  type SlashCommandKind,
} from "@/lib/slash-command";
import {
  ComposerPopover,
  ComposerPopoverGroup,
  ComposerPopoverOption,
} from "./composer/ComposerPopover";

interface SlashCommandPopoverProps {
  /** Listbox id shared with the editor's combobox ARIA. */
  listId: string;
  open: boolean;
  items: SlashCommand[];
  selectedIndex: number;
  onSelect: (commandName: string) => void;
  /** Whether the commands query is loading */
  isLoading: boolean;
  /** Why the provider's own commands could not be listed, if they could not. */
  error?: string | null;
  triggerChar?: string;
  /** When true, Cadencr virtual skills (`kind === "cadencr"`) are shown but
   * disabled because a required MCP dependency (project or workspace) is off. */
  cadencrDisabled?: boolean;
  /** Viewport-aware list height; defaults to 300px. */
  maxHeight?: number;
}

const CADENCR_DISABLED_HINT =
  "Enable the project and workspace MCP (Settings → MCP) to use Cadencr orchestration skills.";

interface SlashCommandItemProps {
  listId: string;
  index: number;
  item: SlashCommand;
  selected: boolean;
  disabled: boolean;
  triggerChar: string;
  onSelect: (commandName: string) => void;
}

function SlashCommandIcon({ kind, selected }: { kind: SlashCommandKind; selected: boolean }) {
  if (kind === "cadencr") return <CadencrLogo className="size-3.5 shrink-0" />;
  const Icon = kind === "skill" ? SparklesIcon : TerminalIcon;
  return (
    <Icon
      className={cn(
        "size-3.5 shrink-0",
        selected ? "text-accent-foreground/80" : "text-muted-foreground",
      )}
    />
  );
}

const SlashCommandItem = memo(function SlashCommandItem({
  listId,
  index,
  item,
  selected,
  disabled,
  triggerChar,
  onSelect,
}: SlashCommandItemProps) {
  return (
    <ComposerPopoverOption
      listId={listId}
      index={index}
      selected={selected}
      disabled={disabled}
      title={disabled ? CADENCR_DISABLED_HINT : item.description || undefined}
      onSelect={() => onSelect(item.name)}
    >
      <SlashCommandIcon kind={item.kind} selected={selected} />
      <span className="shrink-0 font-medium">
        {triggerChar}
        {item.name}
      </span>
      {item.description &&
        (selected ? (
          // Only the highlighted row slides its long description; the rest stay
          // still so the list reads as a list, not a ticker.
          <SlidingText
            text={item.description}
            pxPerSec={24}
            className="min-w-0 flex-1 text-xs text-accent-foreground/80"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {item.description}
          </span>
        ))}
      {item.argumentHint && (
        <span
          className={cn(
            "shrink-0 font-mono text-[11px]",
            selected ? "text-accent-foreground/70" : "text-muted-foreground/70",
          )}
        >
          {item.argumentHint}
        </span>
      )}
    </ComposerPopoverOption>
  );
});

const GROUP_LABEL: Record<SlashCommandKind, string> = {
  cadencr: "Cadencr orchestration",
  skill: "Skills",
  command: "Commands",
};

/** Display order of the groups when the list is unfiltered. */
export const SLASH_COMMAND_GROUP_ORDER: readonly SlashCommandKind[] = [
  "cadencr",
  "skill",
  "command",
];

/** Consecutive runs of the same kind; null when a kind appears in two runs. */
function groupRuns(
  items: SlashCommand[],
): { kind: SlashCommandKind; start: number; end: number }[] | null {
  const runs: { kind: SlashCommandKind; start: number; end: number }[] = [];
  for (const [index, item] of items.entries()) {
    const last = runs.at(-1);
    if (last?.kind === item.kind) last.end = index + 1;
    else if (runs.some((run) => run.kind === item.kind)) return null;
    else runs.push({ kind: item.kind, start: index, end: index + 1 });
  }
  return runs;
}

export function SlashCommandPopover({
  listId,
  open,
  items,
  selectedIndex,
  onSelect,
  isLoading,
  error,
  triggerChar = "/",
  cadencrDisabled = false,
  maxHeight,
}: SlashCommandPopoverProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll selected item into view
  useEffect(() => {
    if (!open || !listRef.current) return;
    const selected = listRef.current.querySelector("[data-selected='true']");
    selected?.scrollIntoView({ block: "nearest" });
  }, [open, selectedIndex]);

  if (!open) return null;

  const renderItem = (item: SlashCommand, index: number): ReactNode => (
    <SlashCommandItem
      key={item.name}
      listId={listId}
      index={index}
      item={item}
      selected={index === selectedIndex}
      disabled={isSlashCommandDisabled(item, !cadencrDisabled)}
      triggerChar={triggerChar}
      onSelect={onSelect}
    />
  );
  const runs = groupRuns(items);
  const status = isLoading ? (
    <>
      <Loader2Icon className="size-3 animate-spin" />
      Loading commands…
    </>
  ) : items.length === 0 && !error ? (
    "No matching commands"
  ) : null;
  const notice =
    error && !isLoading ? (
      <>
        <CircleAlertIcon className="mt-px size-3.5 shrink-0" />
        <span className="min-w-0 break-words">{error}</span>
      </>
    ) : null;

  return (
    <ComposerPopover
      ref={listRef}
      listId={listId}
      label={triggerChar === "$" ? "Skills" : "Commands"}
      maxHeight={maxHeight}
      status={status}
      notice={notice}
    >
      {runs && runs.length > 1
        ? runs.map((run) => (
            <ComposerPopoverGroup key={run.kind} label={GROUP_LABEL[run.kind]}>
              {items
                .slice(run.start, run.end)
                .map((item, offset) => renderItem(item, run.start + offset))}
            </ComposerPopoverGroup>
          ))
        : items.map(renderItem)}
    </ComposerPopover>
  );
}

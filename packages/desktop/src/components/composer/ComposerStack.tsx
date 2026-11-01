import type { ComponentProps, ReactElement, ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  StackFoldContext,
  useSectionFold,
  useShownFold,
  useStackFoldState,
  type SectionFold,
} from "./stack-fold";

/**
 * What a stacked section is about. Each kind keeps one accent, carried by its
 * icon, its title and a faint wash, so a glance tells them apart when several
 * stack at once (`composer.css`, `[data-stack-tone]`).
 */
export type StackTone =
  | "agents"
  | "side"
  | "schedule"
  | "queue"
  | "attention"
  | "question"
  | "worktree"
  | "neutral";

/**
 * Everything stacked on the composer card's top edge — running agents, side
 * questions, schedules, the queue, deferred requests, then what the draft
 * itself calls up (worktree tip, help, skill wizard) — as one tray: one
 * `--muted` wash and hairline, sections parted by hairlines. Empty, it is
 * not drawn. Crowded, its sections fold to one line each but the one open
 * (`stack-fold.ts`); short of room (a phone keyboard), it scrolls before the
 * card below gives up the prompt being typed.
 */
export function ComposerStack({ children }: { children: ReactNode }): ReactElement {
  const fold = useStackFoldState();
  return (
    <StackFoldContext.Provider value={fold}>
      <div
        data-composer-stack
        data-folding={fold.folding || undefined}
        className="@container mx-2 flex max-h-[min(55vh,32rem)] min-h-10 shrink-[100] flex-col divide-y divide-border/60 overflow-x-hidden overflow-y-auto rounded-t-lg border border-b-0 border-border/70 bg-muted/30 transition-colors duration-150 empty:hidden"
      >
        {children}
      </div>
    </StackFoldContext.Provider>
  );
}

interface StackSectionProps extends Omit<ComponentProps<"section">, "title"> {
  tone: StackTone;
  /** Accessible name of the whole section. */
  label: string;
  icon?: ReactNode;
  /** The header's name; without one the section has no header. */
  title?: ReactNode;
  count?: number;
  /** What the section means right now, muted after the title. */
  hint?: ReactNode;
  actions?: ReactNode;
  headerClassName?: string;
  /**
   * The section in one line, shown instead of it when the stack folds.
   * Without one, the section never folds.
   */
  summary?: ReactNode;
  /**
   * Whether showing up opens it in a folded stack (what the user just did,
   * what just answered). Off for what comes and goes on its own.
   */
  opensOnArrival?: boolean;
  /**
   * Its place in the fold, for a section that keeps it while it renders
   * nothing (see `RunningAgents`); by default it registers its own.
   */
  fold?: SectionFold;
}

/** One section of the stack, washed in its tone: a header, then its body. */
export function StackSection({
  tone,
  label,
  icon,
  title,
  count,
  hint,
  actions,
  headerClassName,
  summary,
  opensOnArrival = true,
  fold: lentFold,
  className,
  children,
  ...rest
}: StackSectionProps): ReactElement {
  const ownFold = useSectionFold(!lentFold && summary != null && title != null, opensOnArrival);
  const fold = useShownFold(lentFold ?? ownFold);
  const { folding } = lentFold ?? ownFold;
  return (
    <section
      {...rest}
      ref={fold.sectionRef}
      onFocus={fold.onFocus}
      onBlur={fold.onBlur}
      aria-label={label}
      data-stack-tone={tone}
      data-folded={fold.folded || undefined}
      className={cn("flex shrink-0 flex-col gap-1 px-1.5 py-1.5", fold.folded && "py-1", className)}
    >
      {fold.folded ? (
        <button
          type="button"
          data-stack-fold-toggle=""
          aria-expanded={false}
          onClick={fold.toggle}
          className="flex min-h-6 w-full min-w-0 items-center gap-2 rounded px-1.5 text-left text-[11px] transition-colors hover:bg-background/50 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
        >
          <StackTitle icon={icon} title={title} count={count} />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{summary}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      ) : (
        <>
          {title != null && (
            <StackHeader
              icon={icon}
              title={title}
              count={count}
              hint={hint}
              className={headerClassName}
              actions={
                <>
                  {actions}
                  {folding && (
                    <Button
                      data-stack-fold-toggle=""
                      variant="ghost"
                      size="icon-xs"
                      aria-expanded
                      aria-label={`Fold ${label}`}
                      title="Fold to one line"
                      onClick={fold.toggle}
                      className="size-6 shrink-0 text-muted-foreground"
                    >
                      <ChevronUp className="size-3.5" />
                    </Button>
                  )}
                </>
              }
            />
          )}
          {children}
        </>
      )}
    </section>
  );
}

function StackTitle({
  icon,
  title,
  count,
}: {
  icon: ReactNode;
  title: ReactNode;
  count?: number;
}): ReactElement {
  return (
    <>
      <span data-stack-ink className="flex shrink-0 items-center [&_svg]:size-3.5" aria-hidden>
        {icon}
      </span>
      <span data-stack-ink className="shrink-0 font-medium">
        {title}
        {count != null && <span className="tabular-nums"> · {count}</span>}
      </span>
    </>
  );
}

/**
 * A section's title line: its icon and name in the section's tone, a count,
 * what it means right now, then the section's own actions.
 */
function StackHeader({
  icon,
  title,
  count,
  hint,
  actions,
  className,
}: {
  icon: ReactNode;
  title: ReactNode;
  count?: number;
  hint?: ReactNode;
  actions?: ReactNode;
  className?: string;
}): ReactElement {
  return (
    <header className={cn("flex min-h-6 min-w-0 items-center gap-2 px-1.5 text-[11px]", className)}>
      <StackTitle icon={icon} title={title} count={count} />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{hint}</span>
      {actions}
    </header>
  );
}

/** The rows of a section. */
export function StackList({ children }: { children: ReactNode }): ReactElement {
  return <ol className="flex flex-col gap-1">{children}</ol>;
}

/** Row chrome shared by every section: a lifted line on the tray. */
export const STACK_ROW_CLASS =
  "group flex min-h-8 min-w-0 items-center gap-2 rounded-md bg-background/60 py-1 pr-1 pl-2 text-[13px]";

/** Chrome of a row that is itself the action (an agent to find, a tip to take). */
export const STACK_ROW_BUTTON_CLASS = cn(
  STACK_ROW_CLASS,
  "w-full pr-2 text-left transition-colors hover:bg-background/90 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
);

/** A row's trailing icon action (send now, edit, remove…). */
export function StackRowButton({
  label,
  ariaLabel = label,
  onClick,
  disabled,
  className,
  children,
}: {
  /** The tooltip, and the accessible name unless `ariaLabel` says more. */
  label: string;
  /** What the action applies to, when sections share an action's name. */
  ariaLabel?: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactElement;
}): ReactElement {
  return (
    <ShortcutTooltip label={label}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={ariaLabel}
        onClick={onClick}
        disabled={disabled}
        className={cn("size-7 text-muted-foreground", className)}
      >
        {children}
      </Button>
    </ShortcutTooltip>
  );
}

/** A row's actions: quiet until the row is hovered or focused. */
export function StackRowActions({ children }: { children: ReactNode }): ReactElement {
  return (
    <span className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
      {children}
    </span>
  );
}

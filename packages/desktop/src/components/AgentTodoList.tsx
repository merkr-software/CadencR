import { cn } from "@/lib/utils";
import { CheckIcon, CircleIcon, Loader2Icon } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactElement,
} from "react";
import type { TodoItem } from "@/types/agent";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface AgentTodoListProps {
  todos: TodoItem[];
  chipClass?: string;
  /** `instrument`: the composer card's quiet instrument row (no tinted chip). */
  variant?: "chip" | "instrument";
}

/** Milliseconds the popover stays open after an automatic, todo-change-triggered open. */
const AUTO_OPEN_DURATION_MS = 3000;

/** The task count: a rose chip, or a plain instrument in the composer row. */
const TodoTrigger = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    completed: number;
    total: number;
    inProgress: boolean;
    chipClass?: string;
    variant: "chip" | "instrument";
  }
>(function TodoTrigger({ completed, total, inProgress, chipClass, variant, ...props }, ref) {
  const instrument = variant === "instrument";
  return (
    <button
      {...props}
      ref={ref}
      type="button"
      aria-label={`Tasks: ${completed} of ${total} done`}
      className={
        instrument
          ? "composer-instrument gap-1.5 tabular-nums text-foreground/80"
          : cn(chipClass, "bg-rose-500/15 text-rose-400 hover:bg-rose-500/25")
      }
    >
      {inProgress ? (
        <Loader2Icon
          className={cn("size-3 animate-spin", instrument && "text-[var(--acc-yellow)]")}
        />
      ) : (
        <CheckIcon className={cn("size-3", instrument && "text-[var(--acc-green)]")} />
      )}
      <span>
        {completed}/{total}
      </span>
    </button>
  );
});

export function AgentTodoList({
  todos,
  chipClass,
  variant = "chip",
}: AgentTodoListProps): ReactElement {
  const completed = todos.filter((t) => t.status === "completed").length;
  const total = todos.length;
  const inProgress = todos.find((t) => t.status === "in_progress");

  const [open, setOpen] = useState<boolean>(false);
  const didMountRef = useRef<boolean>(false);
  const autoCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-open for AUTO_OPEN_DURATION_MS on every todos-reference change (skips initial mount).
  // The session store only publishes a new todos array when a TodoWrite block mutates.
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    setOpen(true);
    autoCloseTimerRef.current = setTimeout(() => {
      setOpen(false);
      autoCloseTimerRef.current = null;
    }, AUTO_OPEN_DURATION_MS);
    return (): void => {
      if (autoCloseTimerRef.current !== null) {
        clearTimeout(autoCloseTimerRef.current);
        autoCloseTimerRef.current = null;
      }
    };
  }, [todos]);

  // Respect manual interaction: any user-driven open/close clears the pending auto-close,
  // so the popover doesn't fight the user.
  const handleOpenChange = (next: boolean): void => {
    if (autoCloseTimerRef.current !== null) {
      clearTimeout(autoCloseTimerRef.current);
      autoCloseTimerRef.current = null;
    }
    setOpen(next);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <TodoTrigger
          completed={completed}
          total={total}
          inProgress={!!inProgress}
          chipClass={chipClass}
          variant={variant}
        />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        collisionPadding={12}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="w-auto max-w-[min(640px,90vw)] p-3"
      >
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Tasks
        </p>
        <ul className="space-y-1">
          {todos.map((todo, i) => (
            <li key={i} className="flex items-start gap-2 text-[12px] leading-5">
              {todo.status === "completed" ? (
                <CheckIcon className="mt-0.5 size-3 shrink-0 text-green-400" />
              ) : todo.status === "in_progress" ? (
                <Loader2Icon className="mt-0.5 size-3 shrink-0 animate-spin text-yellow-400" />
              ) : (
                <CircleIcon className="mt-0.5 size-3 shrink-0 text-muted-foreground/40" />
              )}
              <span
                className={cn(
                  "break-words",
                  todo.status === "completed" && "text-muted-foreground line-through",
                  todo.status === "in_progress" && "text-foreground",
                  todo.status === "pending" && "text-muted-foreground/60",
                )}
              >
                {todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

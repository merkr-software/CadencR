import { useEffect, useState, type FocusEvent, type ReactElement } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { LoaderCircle, type LucideIcon } from "lucide-react";
import type { RowSwipe } from "@/hooks/useRowSwipe";
import { cn } from "@/lib/utils";

/** One action's width in the tray: a thumb's target, with room for its label. */
export const ROW_SWIPE_ACTION_WIDTH = 56;

export interface RowSwipeAction {
  key: string;
  label: string;
  /** The accessible name, naming the conversation: `Pin “Fix the build”`. */
  ariaLabel: string;
  icon: LucideIcon;
  onSelect: () => void;
  tone?: "neutral" | "primary" | "destructive";
  /**
   * The write the action starts (an Orval mutation key, variables `{ id }`):
   * the tray stays open with the action spinning until the backend answers.
   * Without one the tray closes on the tap (a dialog or a toast takes over).
   */
  mutationKey?: readonly unknown[];
}

const TONE_CLASS: Record<NonNullable<RowSwipeAction["tone"]>, string> = {
  neutral: "bg-secondary text-secondary-foreground",
  primary: "bg-primary text-primary-foreground",
  destructive: "bg-destructive text-white",
};

export function rowSwipeTrayWidth(actions: readonly RowSwipeAction[]): number {
  return actions.length * ROW_SWIPE_ACTION_WIDTH;
}

/**
 * A sidebar row's swipe actions (phone layout), revealed from the row's right
 * edge as it is swiped left (`useRowSwipe`, `sidebar-phone.css`). Always in the
 * DOM, clipped away when closed: VoiceOver and the keyboard reach the actions
 * without the gesture, and keyboard focus on one opens the tray. Focus coming
 * back from a dialog an action opened (or a tap) leaves it closed.
 */
export function SidebarRowSwipeTray({
  featureId,
  swipe,
  actions,
}: {
  featureId: number;
  swipe: RowSwipe;
  actions: readonly RowSwipeAction[];
}): ReactElement {
  const [pending, setPending] = useState<RowSwipeAction | null>(null);
  const { setOpen } = swipe;
  const select = (action: RowSwipeAction): void => {
    if (pending) return;
    if (action.mutationKey) setPending(action);
    else setOpen(false);
    action.onSelect();
  };
  const openOnKeyboardFocus = (event: FocusEvent<HTMLDivElement>): void => {
    if (isKeyboardFocus(event.target)) setOpen(true);
  };
  const closeOnFocusLeave = (event: FocusEvent<HTMLDivElement>): void => {
    if (pending || event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setOpen(false);
  };
  return (
    <div
      data-row-swipe-tray
      className="sidebar-row-swipe-tray"
      style={{ width: rowSwipeTrayWidth(actions) }}
      onFocus={openOnKeyboardFocus}
      onBlur={closeOnFocusLeave}
    >
      {actions.map((action) => {
        const Icon = action.icon;
        const busy = pending?.key === action.key;
        return (
          <button
            key={action.key}
            type="button"
            aria-label={action.ariaLabel}
            aria-busy={busy || undefined}
            disabled={pending !== null}
            className={cn(
              "flex h-full shrink-0 flex-col items-center justify-center gap-0.5 text-[11px] font-medium outline-none",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-80",
              TONE_CLASS[action.tone ?? "neutral"],
            )}
            style={{ width: ROW_SWIPE_ACTION_WIDTH }}
            onClick={(event) => {
              event.stopPropagation();
              select(action);
            }}
          >
            {busy ? (
              <LoaderCircle aria-hidden className="size-4 animate-spin" />
            ) : (
              <Icon aria-hidden className="size-4" />
            )}
            <span>{action.label}</span>
          </button>
        );
      })}
      {pending?.mutationKey && (
        <MutationSettleWatcher
          mutationKey={pending.mutationKey}
          featureId={featureId}
          onSettled={() => {
            setPending(null);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * Focus a keyboard put there (`:focus-visible`), not focus handed back by a
 * closing dialog after a tap, which would reopen a tray the user just left.
 */
function isKeyboardFocus(target: EventTarget): boolean {
  return target instanceof Element && target.matches(":focus-visible");
}

function hasFeatureId(variables: unknown, featureId: number): boolean {
  return (
    typeof variables === "object" &&
    variables !== null &&
    "id" in variables &&
    variables.id === featureId
  );
}

/**
 * Mounted only while an action's write is in flight, so idle rows subscribe to
 * nothing: reports once no write of that kind for this conversation is pending.
 */
function MutationSettleWatcher({
  mutationKey,
  featureId,
  onSettled,
}: {
  mutationKey: readonly unknown[];
  featureId: number;
  onSettled: () => void;
}): null {
  const inFlight = useIsMutating({
    mutationKey,
    predicate: (mutation) => hasFeatureId(mutation.state.variables, featureId),
  });
  useEffect(() => {
    if (inFlight === 0) onSettled();
  }, [inFlight, onSettled]);
  return null;
}

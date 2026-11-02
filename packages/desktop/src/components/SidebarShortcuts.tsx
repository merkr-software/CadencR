import { useCallback, useRef, type ReactElement, type ReactNode, type RefObject } from "react";
import { toast } from "sonner";
import { useGetFeature, type Feature } from "@/api/generated";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { FeatureRenameForm } from "@/components/FeatureRenamePopover";
import { ForMeDoneContext } from "@/components/SidebarForMeDoneAction";
import { useSidebarAttention } from "@/components/SidebarAttentionProvider";
import { useCrossProjectNavigate } from "@/hooks/useCrossProjectNavigate";
import { useFeatureTitle } from "@/hooks/useFeatureTitle";
import { useGlobalShortcutById, useShortcut } from "@/hooks/useShortcut";
import { apiErrorMessage } from "@/lib/api-errors";
import type { FeatureNavigate } from "@/lib/feature-focus-handoff";
import { getActiveFocusZone } from "@/lib/focus-zones";
import type { ResolvedNextAction } from "@/lib/next-actions";
import { dispatchSidebarRowAction, type SidebarRowAction } from "@/lib/sidebar-row-actions";
import { acknowledgeForMe } from "@/stores/for-me-ack";
import { useSidebarRenameStore } from "@/stores/sidebar-rename-store";
import { useUnreadStore } from "@/stores/unread-store";

const ROW_SHORTCUT_OPTIONS = { enableOnFormTags: false, enableOnContentEditable: false } as const;

/** The conversation row holding keyboard focus in the sidebar, if any. */
function focusedFeatureRow(): HTMLElement | null {
  if (getActiveFocusZone() !== "left-sidebar") return null;
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement)) return null;
  return focused.matches('[data-nav-type="feature"]') ? focused : null;
}

function focusedFeatureId(row: HTMLElement): number | null {
  const id = Number(row.getAttribute("data-nav-id"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Row shortcuts (I8): act on the focused conversation without its menu. */
export function useSidebarRowShortcuts(): void {
  const rowAction = (action: SidebarRowAction) => (event: KeyboardEvent) => {
    const row = focusedFeatureRow();
    if (!row) return;
    event.preventDefault();
    if (!dispatchSidebarRowAction(row, action)) {
      toast.message("This conversation can't do that from here");
    }
  };
  useShortcut("sidebar-row-pin", rowAction("pin"), ROW_SHORTCUT_OPTIONS);
  useShortcut("sidebar-row-archive", rowAction("archive"), ROW_SHORTCUT_OPTIONS);
  useShortcut("sidebar-row-label", rowAction("label"), ROW_SHORTCUT_OPTIONS);
  useShortcut("sidebar-reorder-up", rowAction("move-up"), ROW_SHORTCUT_OPTIONS);
  useShortcut("sidebar-reorder-down", rowAction("move-down"), ROW_SHORTCUT_OPTIONS);
  useShortcut(
    "sidebar-row-rename",
    (event) => {
      const row = focusedFeatureRow();
      const featureId = row && focusedFeatureId(row);
      if (featureId == null) return;
      event.preventDefault();
      useSidebarRenameStore.getState().open(featureId);
    },
    ROW_SHORTCUT_OPTIONS,
  );
  useShortcut(
    "sidebar-row-toggle-unread",
    (event) => {
      const row = focusedFeatureRow();
      const featureId = row && focusedFeatureId(row);
      if (featureId == null) return;
      event.preventDefault();
      useUnreadStore.getState().toggleMarked(featureId);
    },
    ROW_SHORTCUT_OPTIONS,
  );
}

/**
 * Next-in-queue shortcuts (H5): ⌘J goes to the next action in the "For me"
 * list (in its order: pending requests, failures, blocked pull requests,
 * finished turns, merges), ⌥⌘J to the next unread conversation, each cycling
 * on from the open conversation. Opening a failure or an unread reply takes it
 * off its list, so the next press carries on from where it was rather than
 * starting over. ⌥⌘↩ marks the focused row's (else the open conversation's)
 * For me entry done; done with the conversation on screen, the next entry
 * opens (see {@link useMarkDoneAndAdvance}), as it does from the row's check
 * in `children`.
 */
export function SidebarAttentionShortcuts({
  activeFeatureId,
  openFeatureId,
  onSelectFeature,
  children,
}: {
  /** The sidebar's active conversation, kept after leaving it for another page. */
  activeFeatureId: number | null;
  /** The conversation on screen (the route's); null on any other page. */
  openFeatureId: number | null;
  onSelectFeature: (featureId: number) => void;
  children?: ReactNode;
}): ReactElement {
  const { items, actions } = useSidebarAttention();
  const open = useCrossProjectNavigate(activeFeatureId, onSelectFeature);
  // One per shortcut: each remembers its stop in its own list.
  const lastAction = useRef<QueueStop | null>(null);
  const lastUnread = useRef<QueueStop | null>(null);
  const markDone = useMarkDoneAndAdvance(openFeatureId, actions, open, lastAction);
  const jump =
    (queueOf: () => readonly Feature[], emptyMessage: string, last: RefObject<QueueStop | null>) =>
    (event: KeyboardEvent) => {
      event.preventDefault();
      const queue = queueOf();
      if (queue.length === 0) {
        toast.message(emptyMessage);
        return;
      }
      const index = nextQueueIndex(queue, activeFeatureId, last.current);
      const next = queue[index];
      if (!next) return;
      last.current = { featureId: next.id, index };
      open(next);
    };
  useShortcut(
    "attention-next-needs-you",
    jump(() => actions.map((action) => action.feature), "Nothing is waiting on you", lastAction),
  );
  useShortcut(
    "attention-next-unread",
    jump(
      () => items.filter((item) => item.state === "unread").map((item) => item.feature),
      "No unread conversations",
      lastUnread,
    ),
  );
  useGlobalShortcutById("for-me-done", (event) => {
    const row = focusedFeatureRow();
    const featureId = (row && focusedFeatureId(row)) ?? activeFeatureId;
    if (featureId == null) return;
    // Captured before the composer, which would otherwise take ⌥⌘↩ as Enter (send).
    event.preventDefault();
    event.stopPropagation();
    const kind = actions.find((action) => action.feature.id === featureId)?.kind;
    if (kind === undefined) toast.message("Nothing for you here");
    else if (kind === "waiting") toast.message("The agent waits on your answer");
    else markDone(featureId);
  });
  return <ForMeDoneContext.Provider value={markDone}>{children}</ForMeDoneContext.Provider>;
}

/**
 * Marks a For me entry done. Done with the conversation on screen, the user
 * moves on: the entry that takes its place opens, in ⌘J's order and wrapping
 * to the top, and ⌘J carries on from there. With nothing left, the view stays
 * on the conversation just handled. Stable, so the rows reading it don't
 * re-render as the list changes.
 */
function useMarkDoneAndAdvance(
  openFeatureId: number | null,
  actions: readonly ResolvedNextAction[],
  open: FeatureNavigate,
  lastAction: RefObject<QueueStop | null>,
): (featureId: number) => void {
  const live = useRef({ openFeatureId, actions, open });
  live.current = { openFeatureId, actions, open };
  return useCallback(
    (featureId: number) => {
      const current = live.current;
      acknowledgeForMe(featureId);
      if (featureId !== current.openFeatureId) return;
      const queue = current.actions.map((action) => action.feature);
      const at = queue.findIndex((feature) => feature.id === featureId);
      if (at < 0) return;
      const rest = queue.filter((feature) => feature.id !== featureId);
      // The done entry left from `at`: ⌘J's rule picks the one now there.
      const index =
        rest.length > 0 ? nextQueueIndex(rest, featureId, { featureId, index: at }) : -1;
      const next = rest[index];
      if (!next) {
        toast.message("All caught up");
        return;
      }
      lastAction.current = { featureId: next.id, index };
      current.open(next);
    },
    [lastAction],
  );
}

/** Where the last jump landed: the conversation, and its place in its list then. */
interface QueueStop {
  featureId: number;
  index: number;
}

/**
 * The stop after the open conversation. When the open conversation moved since
 * the last jump landed on it (opening it read it, or its action changed), the
 * conversation that took its place comes next; off the list, it starts over.
 */
export function nextQueueIndex(
  queue: readonly Feature[],
  activeFeatureId: number | null,
  lastJump: QueueStop | null,
): number {
  if (lastJump?.featureId === activeFeatureId && queue[lastJump.index]?.id !== activeFeatureId) {
    return lastJump.index % queue.length;
  }
  const at = queue.findIndex((feature) => feature.id === activeFeatureId);
  return at >= 0 ? (at + 1) % queue.length : 0;
}

/** The sidebar's one rename dialog, opened from a row's menu or with F2. */
export function SidebarRenameDialog(): ReactElement {
  const featureId = useSidebarRenameStore((state) => state.featureId);
  const close = useSidebarRenameStore((state) => state.close);
  return (
    <Dialog open={featureId != null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-sm">
        <DialogTitle className="sr-only">Rename conversation</DialogTitle>
        <DialogDescription className="sr-only">
          Give this conversation a new title.
        </DialogDescription>
        {featureId != null && <RenameBody featureId={featureId} onClose={close} />}
      </DialogContent>
    </Dialog>
  );
}

function RenameBody({
  featureId,
  onClose,
}: {
  featureId: number;
  onClose: () => void;
}): ReactElement {
  const { data: feature, isLoading, error } = useGetFeature(featureId);
  const { title: liveTitle } = useFeatureTitle(featureId);
  if (isLoading) return <Skeleton aria-label="Loading conversation" className="h-24" />;
  if (error || !feature) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {apiErrorMessage(error, "Could not load this conversation")}
      </p>
    );
  }
  return (
    <FeatureRenameForm
      featureId={featureId}
      currentTitle={liveTitle ?? feature.title}
      onClose={onClose}
      open
    />
  );
}

import { memo, useRef, type ReactElement, type ReactNode } from "react";
import type { Feature } from "@/api/generated";
import { ActivityTime } from "@/components/ActivityTime";
import { ConversationStatus } from "@/components/ConversationStatus";
import { ProjectBadge } from "@/components/ProjectBadge";
import { useSidebarRowActions } from "@/components/SidebarRowActionsProvider";
import { useCrossProjectRowSwipe } from "@/components/useFeatureRowSwipe";
import { Button } from "@/components/ui/button";
import { useFeatureAttention } from "@/hooks/useFeatureAttention";
import { useFeatureTitle } from "@/hooks/useFeatureTitle";
import { useNow } from "@/hooks/useNow";
import { formatElapsed } from "@/lib/format-elapsed";
import type { NextActionKind } from "@/lib/next-actions";
import { serverToLocalMs } from "@/lib/server-clock";
import { cn } from "@/lib/utils";
import { preloadPressedConversation } from "@/hooks/useConversationPreloadIntent";
import { useFeatureTurnStartedAt } from "@/stores/session-status-selectors";

/** A card's own verb, beside its body (For me's "Answer", "Approve", …). */
export interface InboxCardAction {
  label: string;
  /** The verb's tone classes. */
  className: string;
  onPress: () => void;
}

export interface InboxCardProps {
  feature: Feature;
  projectName: string | undefined;
  /** Under the title: what is asked. */
  summary?: ReactNode;
  /** An agent at work: "Working" and its turn's clock under the title. */
  working?: boolean;
  /** Named after the card's live title for screen readers ("Answer “Fix CI”"). */
  action?: InboxCardAction;
  /** Opens the conversation (`navigateToConversation`). */
  onOpen: (feature: Feature) => void;
  /** A For me card's next action: its swipe tray leads with Done where it can be marked. */
  nextAction?: NextActionKind;
}

/**
 * One conversation in the phone inbox: a card at least 56px tall whose body
 * opens the conversation, its status first, then its title and the time of
 * its last activity, what it asks under them, and its project. A touch on the
 * body preloads the conversation and its view's chunk, so the workspace opens
 * on its transcript. Swiped left on a touch screen, it reveals the sidebar
 * rows' actions (Pin, Archive, a For me card's Done) through the inbox's
 * `SidebarRowActionsProvider`.
 * Memoized and self-subscribed (title, status) by id, so one conversation's
 * push re-renders its own card only.
 */
export const InboxCard = memo(function InboxCard({
  feature,
  projectName,
  summary,
  working = false,
  action,
  onOpen,
  nextAction,
}: InboxCardProps): ReactElement {
  const { title: liveTitle } = useFeatureTitle(feature.id);
  const title = liveTitle ?? feature.title;
  const cardRef = useRef<HTMLLIElement>(null);
  const swipe = useCrossProjectRowSwipe(
    cardRef,
    useSidebarRowActions(),
    feature,
    nextAction,
    liveTitle,
  );
  return (
    <li
      ref={cardRef}
      data-phone-inbox-card={feature.id}
      {...swipe.rowProps}
      className="relative flex min-h-14 min-w-0 items-center gap-1 rounded-xl border border-border/60 bg-card/50"
    >
      <button
        type="button"
        className={cn(
          "flex min-h-14 min-w-0 flex-1 items-start gap-3 rounded-xl py-2.5 pl-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-accent/50",
          // The time keeps the card's inner margin; a verb after it brings its own.
          action ? "pr-1" : "pr-3",
        )}
        onPointerDown={() => preloadPressedConversation(feature.id)}
        onClick={() => onOpen(feature)}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center">
          <InboxStatus featureId={feature.id} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[15px] leading-5 font-medium">
              {title}
            </span>
            <ActivityTime
              iso={feature.last_activity_at ?? feature.created_at}
              className="shrink-0 text-xs tabular-nums text-muted-foreground"
            />
          </span>
          {working ? <WorkingSummary featureId={feature.id} /> : summary}
          <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
            <ProjectBadge projectId={feature.project_id} size="xs" />
            <span className="min-w-0 truncate">{projectName ?? "Unknown project"}</span>
          </span>
        </span>
      </button>
      {action && (
        <div className="shrink-0 pr-2">
          <Button
            variant="raised"
            className={cn("min-h-11 min-w-[4.5rem] px-3", action.className)}
            aria-label={`${action.label} “${title}”`}
            onClick={action.onPress}
          >
            {action.label}
          </Button>
        </div>
      )}
      {swipe.tray}
    </li>
  );
});

/** The palette's status glyph: the sidebar's shapes, a request's icon in its kind's color. */
function InboxStatus({ featureId }: { featureId: number }): ReactElement {
  const { state } = useFeatureAttention(featureId);
  return (
    <ConversationStatus
      featureId={featureId}
      state={state}
      archived={false}
      className="sidebar-pending-indicator size-4"
    />
  );
}

/**
 * "Working · 4:07": how long the agent has been at its turn, from the
 * backend's turn clock. A leaf, so its 1 Hz tick re-renders this line only.
 */
const WorkingSummary = memo(function WorkingSummary({
  featureId,
}: {
  featureId: number;
}): ReactElement {
  const startedAt = useFeatureTurnStartedAt(featureId);
  const anchor = startedAt == null ? null : serverToLocalMs(startedAt);
  const now = useNow(anchor != null, 1_000, anchor);
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-[18px]">
      <span className="font-medium text-blue-500">Working</span>
      {anchor != null && (
        <span className="tabular-nums text-muted-foreground">
          {formatElapsed(Math.max(0, now - anchor))}
        </span>
      )}
    </span>
  );
});

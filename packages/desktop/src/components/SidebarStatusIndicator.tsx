import { memo, useRef, type ReactElement } from "react";
import { SidebarPendingGatePopover } from "@/components/SidebarPendingGatePopover";
import { useAttentionFlash } from "@/hooks/useAttentionFlash";
import { isStrongAttention, type Attention } from "@/lib/sidebar-attention";
import { useSidebarOption } from "@/stores/sidebar-config-store";
import { useOwnsGateAutoOpen } from "@/hooks/useOwnsGateAutoOpen";
import { STATUS_LABELS, StatusShape, type QuietState } from "@/components/StatusShape";

/**
 * Fixed leading slot: status stays legible even when provider branding is
 * hidden. A pending request (answerable from here) and a failed turn always
 * show, whatever the status style: the sidebar never hides what needs you.
 * Its row flashes when the state turns to something worth a look.
 */
export const SidebarStatusIndicator = memo(function SidebarStatusIndicator({
  attention,
  isActive,
  onOpenConversation,
}: {
  attention: Attention;
  isActive: boolean;
  onOpenConversation: () => void;
}): ReactElement {
  const style = useSidebarOption("status");
  const slotRef = useRef<HTMLSpanElement>(null);
  useAttentionFlash(slotRef, attention.state);
  // An empty, hidden slot still anchors the row's flash.
  if (style === "hidden" && !isStrongAttention(attention.state)) {
    return <span ref={slotRef} hidden />;
  }
  return (
    <span
      ref={slotRef}
      data-sidebar-status={attention.state}
      className="inline-flex size-3.5 shrink-0 items-center justify-center"
    >
      {attention.state === "waiting" ? (
        <WaitingIndicator
          featureId={attention.sourceFeatureId}
          isActive={isActive}
          onOpenConversation={onOpenConversation}
        />
      ) : style === "dot" ? (
        <StatusDot state={attention.state} />
      ) : (
        <StatusShape state={attention.state} />
      )}
    </span>
  );
});

/**
 * The quick reply, auto-opening only on the surface that owns it (a waiting
 * conversation can show in the rail, "For me" and the tree at once) and never
 * for the conversation already open.
 */
function WaitingIndicator({
  featureId,
  isActive,
  onOpenConversation,
}: {
  featureId: number;
  isActive: boolean;
  onOpenConversation: () => void;
}): ReactElement {
  const ownsAutoOpen = useOwnsGateAutoOpen();
  return (
    <SidebarPendingGatePopover
      featureId={featureId}
      allowAutoOpen={ownsAutoOpen && !isActive}
      isActive={isActive}
      onOpenConversation={onOpenConversation}
    />
  );
}

const DOT_CLASS: Record<QuietState, string> = {
  failed: "size-2 bg-(--acc-red)",
  working: "sidebar-status-dot-working size-2 bg-blue-500",
  unread: "size-2 bg-(--acc-green)",
  idle: "size-1.5 bg-muted-foreground/30",
};

/** Color-only variant for a quieter sidebar; working still pulses so it reads as live. */
function StatusDot({ state }: { state: QuietState }): ReactElement {
  const { label, title } = STATUS_LABELS[state];
  return (
    <span
      role="img"
      aria-label={label}
      title={title}
      className={`rounded-full ${DOT_CLASS[state]}`}
    />
  );
}

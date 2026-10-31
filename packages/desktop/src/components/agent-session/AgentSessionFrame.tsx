import { memo, type ComponentType, type ReactElement, type ReactNode, type RefObject } from "react";
import type { LucideProps } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentBlockData } from "@/types/agent-block";
import type { LiveAgentStatus } from "@/types/agent";
import type { AgentSessionProps } from "./types";
import { CollapsibleHeader } from "./CollapsibleHeader";
import type { BadgeConfig } from "./CollapsibleHeader";
import { SessionHint } from "./SessionHint";
import { STREAM_DISSOLVE_STYLE } from "./stream-fade";

interface AgentSessionFrameProps extends Pick<
  AgentSessionProps,
  | "collapsible"
  | "className"
  | "navAgentIndex"
  | "maximized"
  | "onMarkDone"
  | "resumable"
  | "onResume"
  | "canDelete"
  | "onDelete"
  | "onToggleMaximize"
> {
  containerRef: RefObject<HTMLDivElement | null>;
  headerRef: RefObject<HTMLDivElement | null>;
  isOpen: boolean;
  isIdle: boolean;
  status: LiveAgentStatus;
  blocks: AgentBlockData[];
  streamContent: ReactNode;
  bottomContent: ReactNode;
  onToggle: () => void;
  IconComponent: ComponentType<LucideProps>;
  badge: BadgeConfig;
  displayLabel: string;
}

export const AgentSessionFrame = memo(function AgentSessionFrame({
  containerRef,
  headerRef,
  collapsible,
  className,
  navAgentIndex,
  maximized,
  isOpen,
  isIdle,
  status,
  blocks,
  streamContent,
  bottomContent,
  onToggle,
  IconComponent,
  badge,
  displayLabel,
  onMarkDone,
  resumable,
  onResume,
  canDelete,
  onDelete,
  onToggleMaximize,
}: AgentSessionFrameProps): ReactElement {
  if (!collapsible) {
    return (
      <div ref={containerRef} className={cn("flex h-full flex-col", className)}>
        {isIdle ? (
          // `min-h-0` matters as much here as on the stream branch below: a bare
          // `flex-1` takes an automatic minimum size equal to its content, so on
          // a short viewport (phone + on-screen keyboard) the hint card refused
          // to shrink, crushed the composer, and shoved the prompt's bottom and
          // send button off-screen. With `min-h-0` the hint yields first — its
          // `flex-basis: 0` means the composer keeps its natural size — and the
          // inner `min-h-full` wrapper keeps the card centred when there IS room
          // while letting it scroll from the top when there isn't (centring
          // directly on a scroll container clips the overflow out of reach).
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-8">
            <div className="flex min-h-full items-center justify-center">
              <SessionHint />
            </div>
          </div>
        ) : (
          // No bottom padding: the dissolve is anchored to this box's bottom
          // edge, which is where the scroller clips. The last message's
          // breathing room lives inside the scroller — see `STREAM_BOTTOM_GAP_PX`.
          <div className="flex-1 min-h-0 px-4 pt-4" style={STREAM_DISSOLVE_STYLE}>
            {streamContent}
          </div>
        )}
        {bottomContent}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex flex-col rounded-lg border border-border bg-background",
        isOpen && maximized && "flex-1 min-h-0",
        isOpen && !maximized && "h-[60vh] min-h-0 shrink-0 overflow-hidden",
        !isOpen && "shrink-0",
        className,
      )}
      {...(navAgentIndex != null ? { "data-agent-container": navAgentIndex } : {})}
    >
      <CollapsibleHeader
        headerRef={headerRef}
        onToggle={onToggle}
        isOpen={isOpen}
        IconComponent={IconComponent}
        badge={badge}
        displayLabel={displayLabel}
        navAgentIndex={navAgentIndex}
        onMarkDone={onMarkDone}
        resumable={resumable}
        onResume={onResume}
        canDelete={canDelete}
        onDelete={onDelete}
        maximized={maximized}
        onToggleMaximize={onToggleMaximize}
      />

      {isOpen && (
        <>
          {blocks.length === 0 && status === "idle" ? (
            <div className="flex flex-1 items-center justify-center border-t border-border/30 p-6 text-sm text-muted-foreground">
              No output yet
            </div>
          ) : (
            // Bottom padding omitted for the same reason as the full-page
            // branch above: the dissolve owns this edge.
            <div
              className="flex-1 min-h-0 border-t border-border/30 px-3"
              style={STREAM_DISSOLVE_STYLE}
            >
              {streamContent}
            </div>
          )}
          {bottomContent}
        </>
      )}
    </div>
  );
});

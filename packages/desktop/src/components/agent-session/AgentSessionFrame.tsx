import { memo, type ComponentType, type ReactElement, type ReactNode, type RefObject } from "react";
import type { LucideProps } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentBlockData } from "../AgentBlock";
import type { LiveAgentStatus } from "@/types/agent";
import type { AgentSessionProps } from "./types";
import { CollapsibleHeader } from "./CollapsibleHeader";
import type { BadgeConfig } from "./CollapsibleHeader";
import { SessionHint } from "./SessionHint";

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
          <div className="flex flex-1 items-center justify-center px-4 pt-4 pb-8">
            <SessionHint />
          </div>
        ) : (
          <div className="flex-1 min-h-0 px-4 pt-4 pb-8">{streamContent}</div>
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
            <div className="flex-1 min-h-0 border-t border-border/30 px-3 pb-6">
              {streamContent}
            </div>
          )}
          {bottomContent}
        </>
      )}
    </div>
  );
});

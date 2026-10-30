import { memo, type ReactElement } from "react";
import { Check, CircleAlert, CircleStop } from "lucide-react";
import type { SubagentRunStatus } from "@/api/generated";
import { STATUS_LABEL } from "@/lib/subagents/subagent-presentation";
import { cn } from "@/lib/utils";

/**
 * A sub-agent's status in the sidebar's shapes and classes (`StatusShape`'s
 * labels are a conversation's), so "working" reads the same everywhere: the
 * blue ring turns, a check settles, an alert asks for a look with its halo, a
 * stop square stays quiet.
 */
export const SubagentStatusGlyph = memo(function SubagentStatusGlyph({
  status,
  label,
  className,
}: {
  status: SubagentRunStatus;
  /** Accessible name; defaults to the status word. */
  label?: string;
  className?: string;
}): ReactElement {
  const name = label ?? STATUS_LABEL[status];
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      data-subagent-status={status}
      className={cn("inline-flex size-3.5 shrink-0 items-center justify-center", className)}
    >
      {status === "running" && <span aria-hidden="true" className="sidebar-status-working" />}
      {status === "completed" && (
        <span aria-hidden="true" className="sidebar-status-unread">
          <Check className="size-3.5" strokeWidth={3} />
        </span>
      )}
      {status === "failed" && (
        <span aria-hidden="true" className="sidebar-status-failed">
          <CircleAlert className="size-3.5" strokeWidth={2.5} />
        </span>
      )}
      {status === "stopped" && (
        <CircleStop aria-hidden="true" className="size-3.5 text-muted-foreground" strokeWidth={2} />
      )}
    </span>
  );
});

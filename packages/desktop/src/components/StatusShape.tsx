import type { ReactElement } from "react";
import { Check, CircleAlert } from "lucide-react";
import type { Attention } from "@/lib/sidebar-attention";

export type QuietState = Exclude<Attention["state"], "waiting">;

export const STATUS_LABELS: Record<QuietState, { label: string; title?: string }> = {
  failed: { label: "Agent turn failed", title: "Agent stopped on an error · Not seen yet" },
  working: { label: "Agent working", title: "Agent working" },
  unread: { label: "Unread agent messages", title: "Agent finished · Unread messages" },
  idle: { label: "Agent idle" },
};

/**
 * The status mark for a state that needs no action: the sidebar's leading
 * slot and the unified agents cards' title line both draw it, so a
 * conversation reads the same in both places.
 */
export function StatusShape({ state }: { state: QuietState }): ReactElement {
  const { label, title } = STATUS_LABELS[state];
  if (state === "working") {
    return <span role="img" aria-label={label} title={title} className="sidebar-status-working" />;
  }
  if (state === "unread") {
    return (
      <span role="img" aria-label={label} title={title} className="sidebar-status-unread">
        <Check aria-hidden="true" className="size-3.5" strokeWidth={3} />
      </span>
    );
  }
  if (state === "failed") {
    return (
      <span role="img" aria-label={label} title={title} className="sidebar-status-failed">
        <CircleAlert aria-hidden="true" className="size-3.5" strokeWidth={2.5} />
      </span>
    );
  }
  return (
    <span role="img" aria-label={label} className="size-1.5 rounded-full bg-muted-foreground/30" />
  );
}

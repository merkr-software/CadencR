/**
 * Backend connection status pill rendered next to the Settings link in
 * the sidebar. Hidden entirely when the connection is healthy — only
 * appears during `reconnecting` (amber, pulsing), `disconnected` (red),
 * or `manual_reconnect_required` (red) states. Click opens a popover
 * with the disconnection reason, the time we last had a healthy
 * connection, and a "Retry now" button.
 *
 * Status colors follow the same Tailwind palette as
 * `CustomActionStatusDot` for visual consistency with the existing
 * status-dot system.
 */

import { type ReactElement } from "react";
import { cn } from "@/lib/utils";
import { useConnectionStatus, useConnectionStatusStore } from "@/stores/connection-status-store";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";

interface ConnectionStatusIndicatorProps {
  className?: string;
}

export function ConnectionStatusIndicator({
  className,
}: ConnectionStatusIndicatorProps): ReactElement | null {
  const { status, reason, lastConnectedAt } = useConnectionStatus();

  // Hide entirely while healthy — per the chosen UX, the indicator only
  // surfaces when there's an actual problem.
  if (status === "connected") return null;

  // Computed at render time; the popover is only visible while
  // disconnected/reconnecting, and a parent re-render is what shows it,
  // so this stays fresh enough without a memo or interval.
  const lastConnectedLabel = lastConnectedAt == null ? null : formatRelativeAge(lastConnectedAt);

  const isManualRequired = status === "manual_reconnect_required";
  const dotColor = status === "reconnecting" ? "bg-amber-500 animate-pulse" : "bg-red-500";
  const label =
    status === "reconnecting"
      ? "Reconnecting…"
      : isManualRequired
        ? "Reconnect paused"
        : "Disconnected";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Backend ${label}${reason ? ` — ${reason}` : ""}`}
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-medium",
            "hover:bg-accent transition-colors focus-visible:outline-none focus-visible:bg-accent",
            status === "reconnecting" && "text-amber-500",
            (status === "disconnected" || isManualRequired) && "text-red-500",
            className,
          )}
        >
          <span className={cn("size-2 rounded-full", dotColor)} />
          <span>{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8} className="w-72 text-xs">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className={cn("size-2 rounded-full", dotColor)} />
            <span className="font-semibold">
              {status === "reconnecting"
                ? "Reconnecting to backend"
                : isManualRequired
                  ? "Backend reconnect paused"
                  : "Backend disconnected"}
            </span>
          </div>
          {reason ? (
            <p className="text-muted-foreground leading-relaxed break-words">{reason}</p>
          ) : null}
          {lastConnectedLabel ? (
            <p className="text-muted-foreground">Last connected {lastConnectedLabel}</p>
          ) : null}
          <button
            type="button"
            className={cn(
              "mt-1 self-start px-2 py-1 text-xs rounded border",
              "hover:bg-accent transition-colors focus-visible:outline-none focus-visible:bg-accent",
            )}
            onClick={() =>
              useConnectionStatusStore.getState().forceReconnectAll({ bypassManualPause: true })
            }
          >
            Retry now
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function formatRelativeAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

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
import { formatConnectionReason } from "@/lib/connection-reason";
import { formatCompactAge } from "@/lib/date-utils";
import { formattingLocale } from "@/lib/i18n/formatting-locale";
import { useUiTranslation } from "@/lib/i18n/ui";
import { cn } from "@/lib/utils";
import { useConnectionStatus, useConnectionStatusStore } from "@/stores/connection-status-store";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";

interface ConnectionStatusIndicatorProps {
  className?: string;
}

export function ConnectionStatusIndicator({
  className,
}: ConnectionStatusIndicatorProps): ReactElement | null {
  const { t, i18n } = useUiTranslation();
  const { status, reason, lastConnectedAt } = useConnectionStatus();

  // Hide entirely while healthy — per the chosen UX, the indicator only
  // surfaces when there's an actual problem.
  if (status === "connected") return null;

  // Computed at render time; the popover is only visible while
  // disconnected/reconnecting, and a parent re-render is what shows it,
  // so this stays fresh enough without a memo or interval.
  const locale = formattingLocale(i18n.language);
  const lastConnectedLabel =
    lastConnectedAt == null
      ? null
      : formatCompactAge(lastConnectedAt, t, locale, { showSeconds: true });
  const reasonLabel = reason ? formatConnectionReason(reason, t, locale) : null;

  const isManualRequired = status === "manual_reconnect_required";
  const dotColor = status === "reconnecting" ? "bg-amber-500 animate-pulse" : "bg-red-500";
  const label =
    status === "reconnecting"
      ? t("conversation.connection.reconnecting", "Reconnecting…")
      : isManualRequired
        ? t("conversation.connection.reconnectPaused", "Reconnect paused")
        : t("conversation.connection.disconnectedStatus", "Disconnected");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            reasonLabel
              ? t("conversation.connection.statusWithReason", "Backend {{status}} — {{reason}}", {
                  status: label,
                  reason: reasonLabel,
                })
              : t("conversation.connection.status", "Backend {{status}}", { status: label })
          }
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
                ? t("conversation.connection.reconnectingToBackend", "Reconnecting to backend")
                : isManualRequired
                  ? t("conversation.connection.paused", "Backend reconnect paused")
                  : t("conversation.connection.backendDisconnected", "Backend disconnected")}
            </span>
          </div>
          {reasonLabel ? (
            <p className="text-muted-foreground leading-relaxed break-words">{reasonLabel}</p>
          ) : null}
          {lastConnectedLabel ? (
            <p className="text-muted-foreground">
              {t("conversation.connection.lastConnected", "Last connected {{age}}", {
                age: lastConnectedLabel,
              })}
            </p>
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
            {t("conversation.connection.retryNow", "Retry now")}
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

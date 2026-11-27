import { useUiTranslation } from "@/lib/i18n/ui";
import type { ComponentProps, ReactElement } from "react";
import { useMinuteClock } from "@/hooks/useMinuteClock";
import { parseUTCDateTime } from "@/lib/date-utils";
import {
  formatSidebarAbsoluteTime,
  formatSidebarFullTime,
  formatSidebarRelativeTime,
} from "@/lib/sidebar-time";

type ActivityTimeProps = Omit<ComponentProps<"time">, "children" | "dateTime" | "title"> & {
  /** A backend timestamp (UTC); nothing renders for a missing or invalid one. */
  iso: string | null | undefined;
  mode?: "relative" | "absolute";
};

/**
 * A conversation's last activity as the sidebar writes it ("5m", "2h", or the
 * absolute time), the full date in its tooltip, on the shared minute clock.
 */
export function ActivityTime({
  iso,
  mode = "relative",
  ...props
}: ActivityTimeProps): ReactElement | null {
  // Re-render on a language change: the labels follow the interface locale.
  useUiTranslation();
  const now = useMinuteClock();
  if (!iso) return null;
  const date = parseUTCDateTime(iso);
  if (Number.isNaN(date.getTime())) return null;
  return (
    <time {...props} dateTime={date.toISOString()} title={formatSidebarFullTime(date)}>
      {mode === "relative"
        ? formatSidebarRelativeTime(date, now)
        : formatSidebarAbsoluteTime(date, now)}
    </time>
  );
}

import { formattingLocale } from "@/lib/i18n/formatting-locale";
import { formatExactNumber } from "@/lib/format-number";
import { formatClock } from "@/lib/format-clock";
import { useUiTranslation } from "@/lib/i18n/ui";
import { BellOffIcon } from "lucide-react";
import { NOTCH_SNOOZE_MINUTES, type NotchSnoozeMinutes } from "@/shared/notch";
import { formatSnoozeDuration } from "./notch-format";

/**
 * Mutes the island — compact ears and peeks — for a while; hovering the notch
 * still opens the list.
 */
export function SnoozeChips({
  onSnooze,
}: {
  onSnooze: (minutes: NotchSnoozeMinutes) => void;
}): React.JSX.Element {
  const { t, i18n } = useUiTranslation();
  const locale = formattingLocale(i18n.language);
  return (
    <div className="snooze" role="group" aria-label={t("notch.snooze.group", "Snooze the notch")}>
      <span className="snooze-label">
        <BellOffIcon aria-hidden="true" />
        {t("notch.snooze.label", "Snooze")}
      </span>
      {NOTCH_SNOOZE_MINUTES.map((minutes) => (
        <button
          key={minutes}
          type="button"
          className="snooze-chip"
          title={t("notch.snooze.forMinutes", "Snooze for {{formattedCount}} minutes", {
            formattedCount: formatExactNumber(minutes, locale),
          })}
          onClick={() => onSnooze(minutes)}
        >
          {formatSnoozeDuration(minutes, t, locale)}
        </button>
      ))}
    </div>
  );
}

/** The panel's footer: the chips, or how long the island stays muted and the way back. */
export function PanelSnooze({
  snoozedUntil,
  onSnooze,
}: {
  snoozedUntil: number | null;
  onSnooze: (minutes: NotchSnoozeMinutes | null) => void;
}): React.JSX.Element {
  const { t, i18n } = useUiTranslation();
  if (snoozedUntil == null) return <SnoozeChips onSnooze={onSnooze} />;
  return (
    <div className="snooze">
      <span className="snooze-label">
        <BellOffIcon aria-hidden="true" />
        {t("notch.snooze.until", "Snoozed until {{time}}", {
          time: formatClock(snoozedUntil, formattingLocale(i18n.language)),
        })}
      </span>
      <button type="button" className="snooze-chip" onClick={() => onSnooze(null)}>
        {t("notch.snooze.resume", "Resume")}
      </button>
    </div>
  );
}

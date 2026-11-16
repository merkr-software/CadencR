import { BellOffIcon } from "lucide-react";
import { NOTCH_SNOOZE_MINUTES, type NotchSnoozeMinutes } from "@/shared/notch";
import { formatClock } from "./notch-format";

const LABEL: Record<NotchSnoozeMinutes, string> = {
  5: "5m",
  30: "30m",
  60: "1h",
  90: "1h30",
  120: "2h",
};

/**
 * Mutes the island — compact ears and peeks — for a while; hovering the notch
 * still opens the list.
 */
export function SnoozeChips({
  onSnooze,
}: {
  onSnooze: (minutes: NotchSnoozeMinutes) => void;
}): React.JSX.Element {
  return (
    <div className="snooze" role="group" aria-label="Snooze the notch">
      <span className="snooze-label">
        <BellOffIcon aria-hidden="true" />
        Snooze
      </span>
      {NOTCH_SNOOZE_MINUTES.map((minutes) => (
        <button
          key={minutes}
          type="button"
          className="snooze-chip"
          title={`Snooze for ${minutes} minutes`}
          onClick={() => onSnooze(minutes)}
        >
          {LABEL[minutes]}
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
  if (snoozedUntil == null) return <SnoozeChips onSnooze={onSnooze} />;
  return (
    <div className="snooze">
      <span className="snooze-label">
        <BellOffIcon aria-hidden="true" />
        Snoozed until {formatClock(snoozedUntil)}
      </span>
      <button type="button" className="snooze-chip" onClick={() => onSnooze(null)}>
        Resume
      </button>
    </div>
  );
}

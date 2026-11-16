import { memo, type CSSProperties } from "react";
import type { NotchAgent } from "@/shared/notch";
import { activityDots } from "./notch-activity-layout";
import { aggregateOrbState } from "./NotchPanel";

/** A three-point status mark on the left, with tiny session status circles on the right. */
export const NotchActivityStrip = memo(function NotchActivityStrip({
  agents,
  still,
  width,
  height,
}: {
  agents: readonly NotchAgent[];
  still: boolean;
  width: number;
  height: number;
}): React.JSX.Element {
  const working = agents.filter((agent) => agent.status === "running").length;
  const waiting = agents.filter((agent) => agent.status === "question").length;
  const unread = agents.length - working - waiting;
  const { shown, extra, countWidth } = activityDots(agents, width);
  return (
    <div
      className="activity-strip"
      data-still={still}
      style={{ "--count-size": `${Math.min(height, 6)}px` } as CSSProperties}
      role="img"
      aria-label={`${working} working, ${waiting} waiting, ${unread} unread${extra > 0 ? `; ${extra} more sessions` : ""}`}
    >
      <span className="activity-logo" data-state={aggregateOrbState(agents)} aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <span key={index} className="activity-logo-point" />
        ))}
      </span>
      <span className="activity-statuses" aria-hidden="true">
        {shown.map((agent, index) => (
          <span
            key={agent.featureId}
            className="activity-segment"
            data-status={agent.status}
            data-kind={agent.pendingKind}
            style={{ "--i": index } as CSSProperties}
          />
        ))}
        {extra > 0 ? (
          <span className="activity-count" style={{ width: countWidth }}>
            +{extra}
          </span>
        ) : null}
      </span>
    </div>
  );
});

import { memo, type CSSProperties } from "react";
import { FAVICON_CUT, ringDots } from "@cadencr/brand";

export type OrbStatus = "idle" | "running" | "question" | "done";
/** A status, or `logo`: the plain Cadencr mark, which never moves. */
type OrbState = OrbStatus | "logo";

const DOTS = ringDots();

/**
 * The "Index Dots" mark (12 dots around a core, on a 48 grid — the ≤32px cut) as the island's
 * status glyph: a comet chases the ring while an agent works, the ring pulses
 * when one waits for you, and floods green — drawing a check — when one is done.
 * As `logo` it is just the brand mark, still.
 */
export const IndexDotsOrb = memo(function IndexDotsOrb({
  state,
  size = 18,
}: {
  state: OrbState;
  size?: number;
}): React.JSX.Element {
  return (
    <svg
      className="orb"
      data-state={state}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
      // Remount on state change so the land/draw sequence replays.
      key={state}
    >
      {DOTS.map((dot, i) => (
        <circle
          key={i}
          className="orb-dot"
          cx={dot.cx}
          cy={dot.cy}
          r={FAVICON_CUT.dotR}
          style={{ "--i": i } as CSSProperties}
        />
      ))}
      <circle className="orb-core" cx={24} cy={24} r={FAVICON_CUT.coreR} />
      {state === "done" ? <path className="orb-check" d="M18.5 24.5l3.8 3.8 7.5-8" /> : null}
    </svg>
  );
});

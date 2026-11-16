import { memo, type ReactElement, type RefObject } from "react";
import { cn } from "@/lib/utils";

type DivRef = RefObject<HTMLDivElement | null>;

/**
 * One of the composer's two instrument rows: a start zone and an end zone.
 * Rendered empty — the instruments' hosts move into its zones
 * (`useInstrumentRows`). The top row is the card's session header.
 */
export const InstrumentRow = memo(function InstrumentRow({
  start,
  end,
  rowRef,
  top = false,
  hidden = false,
}: {
  start: DivRef;
  end: DivRef;
  /** Set on the row whose width both rows share. */
  rowRef?: DivRef;
  top?: boolean;
  hidden?: boolean;
}): ReactElement {
  return (
    <div
      ref={rowRef}
      data-composer-instruments
      className={cn(
        "@container shrink-0 items-center gap-1.5 px-2",
        top ? "pt-2" : "pb-2",
        hidden ? "hidden" : "flex",
      )}
    >
      <div
        ref={start}
        data-composer-zone
        className="flex min-w-0 items-center gap-0.5 overflow-hidden"
      />
      <div ref={end} data-composer-zone className="ml-auto flex shrink-0 items-center gap-1.5" />
    </div>
  );
});

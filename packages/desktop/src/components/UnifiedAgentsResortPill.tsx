import { memo, type ReactElement } from "react";
import { ArrowDownUpIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Floats over the top of the grid while the shown order lags the sorted one
 * (agents changed state since the cards were laid out). The grid stays still
 * until the user asks for the new order.
 */
export const UnifiedAgentsResortPill = memo(function UnifiedAgentsResortPill({
  changes,
  onResort,
}: {
  changes: number;
  onResort: () => void;
}): ReactElement | null {
  if (changes === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={onResort}
        className="unified-agents-resort-pill pointer-events-auto h-7 gap-1.5 rounded-full border border-border px-3 text-xs shadow-md"
      >
        <ArrowDownUpIcon className="size-3.5" />
        {changes === 1 ? "1 agent changed" : `${changes} agents changed`}
        <span className="text-muted-foreground">·</span>
        <span className="font-semibold">Re-sort</span>
      </Button>
    </div>
  );
});

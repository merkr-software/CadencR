import { memo, type ReactElement } from "react";
import { Badge } from "@/components/ui/badge";
import { SlidingText } from "@/components/SlidingText";
import { cn } from "@/lib/utils";

interface FeatureLabelChipProps {
  label?: string | null;
  className?: string;
}

export const FeatureLabelChip = memo(function FeatureLabelChip({
  label,
  className,
}: FeatureLabelChipProps): ReactElement | null {
  if (!label) return null;
  return (
    <Badge
      variant="secondary"
      data-feature-label
      title={label}
      className={cn(
        "inline-flex min-w-0 max-w-36 shrink-0 items-center rounded-md border border-primary/30 bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary",
        className,
      )}
    >
      <SlidingText text={label} />
    </Badge>
  );
});

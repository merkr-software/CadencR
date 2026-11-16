import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MAX_HALOS } from "@/lib/themes/halo-composition";

export function HaloCountControl({
  count,
  disabled,
  onChange,
}: {
  count: number;
  disabled: boolean;
  onChange: (count: number) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-medium text-muted-foreground">Number of halos</span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon-xs"
          aria-label="Remove halo"
          disabled={disabled || count <= 1}
          onClick={() => onChange(count - 1)}
        >
          <Minus className="size-3" />
        </Button>
        <span className="min-w-10 text-center font-mono text-xs tabular-nums" aria-live="polite">
          {count} / {MAX_HALOS}
        </span>
        <Button
          variant="outline"
          size="icon-xs"
          aria-label="Add halo"
          disabled={disabled || count >= MAX_HALOS}
          onClick={() => onChange(count + 1)}
        >
          <Plus className="size-3" />
        </Button>
      </div>
    </div>
  );
}

import { memo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface LargeFileBannerProps {
  /** Opt into the full editor (read-write, syntax + language features). */
  onEditAnyway: () => void;
}

/**
 * Inline banner shown above the editor when a file opens in read-only
 * large-file mode. Mirrors the visual style of `LargeDiffPlaceholder` —
 * same `bg-muted/40` card, `Badge`, and `outline` button.
 */
export const LargeFileBanner = memo(function LargeFileBanner({
  onEditAnyway,
}: LargeFileBannerProps) {
  return (
    <div className="bg-muted/40 flex items-center justify-between gap-4 border-b p-4">
      <div className="flex items-center gap-2">
        <Badge variant="outline">Large file</Badge>
        <span className="text-muted-foreground text-xs">
          Opened read-only, language features disabled.
        </span>
      </div>
      <Button variant="outline" size="sm" onClick={onEditAnyway}>
        Edit anyway
      </Button>
    </div>
  );
});

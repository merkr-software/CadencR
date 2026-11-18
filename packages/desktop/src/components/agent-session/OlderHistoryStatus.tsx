import { memo, type ReactElement } from "react";
import { Loader2Icon, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Pinned above the first transcript row while older history loads (spinner)
 * or after a page failed to load: a destructive line with the reason and a
 * Retry, rather than a toast that vanishes before the reader scrolls back up.
 */
export const OlderHistoryStatus = memo(function OlderHistoryStatus({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
}): ReactElement | null {
  if (loading) {
    return (
      <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center">
        <div className="rounded-full border bg-background/80 p-1 shadow-sm backdrop-blur">
          <Loader2Icon className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }
  if (error == null) return null;
  return (
    <div className="absolute inset-x-0 top-2 z-20 flex justify-center px-4">
      <div
        role="alert"
        className="flex min-w-0 max-w-full items-center gap-2 rounded-full border border-destructive/30 bg-background/90 px-3 py-1 text-xs shadow-sm backdrop-blur"
      >
        <TriangleAlert className="size-3.5 shrink-0 text-destructive" aria-hidden />
        <span className="shrink-0 font-medium text-destructive">Couldn't load older messages</span>
        <span className="min-w-0 truncate text-muted-foreground" title={error}>
          {error}
        </span>
        {onRetry ? (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="h-auto shrink-0 p-0"
            onClick={onRetry}
          >
            Retry
          </Button>
        ) : null}
      </div>
    </div>
  );
});

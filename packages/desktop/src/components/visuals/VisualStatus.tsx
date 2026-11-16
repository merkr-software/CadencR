import { AlertTriangleIcon, Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";

interface VisualLoadingProps {
  /** What is happening right now: "Writing chart…", "Loading d3…". */
  label: string;
  detail?: string;
  /** Cover the (still blank) visual instead of standing in for it. */
  overlay?: boolean;
}

/**
 * Holds a visual's place until it has painted and says which step it is at,
 * since visuals have no frame of their own to show that something is coming.
 */
export function VisualLoading({ label, detail, overlay = false }: VisualLoadingProps) {
  return (
    <div
      role="status"
      className={cn(
        "flex min-h-24 items-center justify-center gap-2 rounded-md bg-muted/40 px-3 text-xs text-muted-foreground",
        overlay ? "absolute inset-0" : "my-2",
      )}
    >
      <Loader2Icon className="size-3 shrink-0 animate-spin" />
      <span>{label}</span>
      {detail && <span className="text-muted-foreground/70">· {detail}</span>}
    </div>
  );
}

/** A failure notice above a visual (or its source). */
export function VisualError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="my-1 flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
    >
      <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
      <span className="min-w-0 break-words">{message}</span>
    </div>
  );
}

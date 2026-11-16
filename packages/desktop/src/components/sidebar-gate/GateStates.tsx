import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export const GATE_BODY_PADDING = "p-3.5";

export function gateButtonSize(touch: boolean): string {
  return touch ? "h-11 text-sm" : "h-8 text-xs";
}

export function GateSkeleton({ touch }: { touch: boolean }): ReactElement {
  return (
    <div
      role="status"
      aria-label="Loading request"
      className={cn("flex flex-col gap-2.5", GATE_BODY_PADDING)}
    >
      <Skeleton className="h-3 w-3/4" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className={cn("w-full", touch ? "h-11" : "h-8")} />
    </div>
  );
}

interface GateMessageProps {
  /** What to say: an error, or that the request is gone. */
  message: string;
  touch: boolean;
  autoFocus: boolean;
  onOpenConversation: () => void;
  /** Muted explanation (error, empty) or plain text (plan ready). */
  tone: "muted" | "plain";
}

/** A one-line state with the way out: the conversation. */
export function GateMessage({
  message,
  touch,
  autoFocus,
  onOpenConversation,
  tone,
}: GateMessageProps): ReactElement {
  return (
    <div className={cn("flex flex-col gap-2.5", GATE_BODY_PADDING, touch ? "text-sm" : "text-xs")}>
      <p className={tone === "muted" ? "text-muted-foreground" : "font-medium text-foreground"}>
        {message}
      </p>
      <Button
        size="sm"
        variant="raised"
        className={gateButtonSize(touch)}
        autoFocus={autoFocus}
        onClick={onOpenConversation}
      >
        Open conversation
      </Button>
    </div>
  );
}

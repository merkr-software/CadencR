import { useState, type ReactElement } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * "Later" on a gate in the phone layout (permission, question): folds the
 * request away unanswered, the agent still waiting on it, the composer back.
 * It replaces the close button, which stopped the agent. A 44px target whose
 * negative margin keeps the header line as short as before.
 */
export function GateLaterButton({
  onLater,
  className,
}: {
  onLater: () => void;
  className?: string;
}): ReactElement {
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onLater}
      aria-label="Later: hide this request, the agent keeps waiting"
      className={cn("-my-2.5 -mr-2 ml-auto h-11 px-3 text-sm text-muted-foreground", className)}
    >
      Later
    </Button>
  );
}

/**
 * Stopping the agent from a gate in the phone layout: a quiet text button
 * that asks first, since a stop ends the turn the question belongs to.
 */
export function GateStopButton({
  onStop,
  disabled,
}: {
  onStop: () => void;
  disabled?: boolean;
}): ReactElement {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        disabled={disabled}
        onClick={() => setConfirming(true)}
        className="-ml-3 h-11 px-3 text-sm text-destructive hover:text-destructive"
      >
        Stop agent
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Stop the agent?"
        description="It stops waiting for your answer and ends its turn. Later keeps it waiting instead."
        confirmText="Stop agent"
        variant="destructive"
        onConfirm={onStop}
      />
    </>
  );
}

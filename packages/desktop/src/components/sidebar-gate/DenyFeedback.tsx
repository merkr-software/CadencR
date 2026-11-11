import { useState, type KeyboardEvent, type ReactElement } from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DENY_FIELD_ATTRIBUTE } from "@/components/sidebar-gate-popover/gate-content-events";
import { cn } from "@/lib/utils";
import { gateButtonSize } from "./GateStates";

interface DenyFeedbackProps {
  isSubmitting: boolean;
  touch: boolean;
  /** The trimmed message; empty when the user wrote nothing. */
  onSubmit: (message: string) => void;
  onCancel: () => void;
}

/** What replaces the actions once a deny that takes feedback was chosen. */
export function DenyFeedback({
  isSubmitting,
  touch,
  onSubmit,
  onCancel,
}: DenyFeedbackProps): ReactElement {
  const [message, setMessage] = useState("");
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Escape") {
      // Cancels the field, not the popover around it (which keeps Radix from
      // dismissing: see `keepEscapeInDenyField`).
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSubmit(message.trim());
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        autoFocus
        {...{ [DENY_FIELD_ATTRIBUTE]: "" }}
        rows={2}
        value={message}
        disabled={isSubmitting}
        aria-label="Tell the agent what to do instead"
        placeholder="Tell the agent what to do instead (optional)"
        className={cn(
          "max-h-40 resize-none bg-muted/30 text-xs md:text-xs",
          touch && "text-sm md:text-sm",
        )}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className={cn("flex gap-1.5", touch ? "flex-col-reverse" : "justify-end")}>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={isSubmitting}
          className={gateButtonSize(touch)}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={isSubmitting}
          className={gateButtonSize(touch)}
          onClick={() => onSubmit(message.trim())}
        >
          {isSubmitting ? <Loader2Icon className="animate-spin" aria-label="Sending" /> : null}
          Deny
        </Button>
      </div>
    </div>
  );
}

import { useState, type ReactElement } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { useUiTranslation } from "@/lib/i18n/ui";
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
  const { t } = useUiTranslation();
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onLater}
      aria-label={t("phone.gate.laterLabel", "Later: hide this request, the agent keeps waiting")}
      className={cn("-my-2.5 -mr-2 ml-auto h-11 px-3 text-sm text-muted-foreground", className)}
    >
      {t("phone.gate.later", "Later")}
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
  const { t } = useUiTranslation();
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
        {t("conversation.composer.promptBarActions.stopAgent", "Stop agent")}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("phone.gate.stopConfirmTitle", "Stop the agent?")}
        description={t(
          "phone.gate.stopConfirmDescription",
          "It stops waiting for your answer and ends its turn. Later keeps it waiting instead.",
        )}
        confirmText={t("conversation.composer.promptBarActions.stopAgent", "Stop agent")}
        variant="destructive"
        onConfirm={onStop}
      />
    </>
  );
}

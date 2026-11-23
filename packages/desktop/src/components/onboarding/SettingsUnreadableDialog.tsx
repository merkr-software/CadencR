import { Loader2 } from "lucide-react";
import { apiErrorMessage } from "@/lib/api-errors";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The workspace settings file exists but the service cannot read it. Reading it
 * as "unset" would restart onboarding over a finished setup, so the gate says
 * what failed (the message names the file and the cause) and lets the user
 * retry or go straight to Settings.
 */
export function SettingsUnreadableDialog({
  error,
  retry,
  busy,
  openSettings,
}: {
  error: unknown;
  retry: () => void;
  busy: boolean;
  openSettings: () => void;
}): React.JSX.Element {
  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className="sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>Cadencr can't read your settings</DialogTitle>
          <DialogDescription>
            Setup and preferences stay on hold until the settings file can be read. Fix or replace
            it, then retry.
          </DialogDescription>
        </DialogHeader>
        <p
          role="alert"
          className="whitespace-pre-wrap break-words rounded-md bg-muted/60 p-3 font-mono text-xs text-destructive"
        >
          {apiErrorMessage(error, "The settings file could not be read.")}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={retry}>
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            Retry
          </Button>
          <Button onClick={openSettings}>Open Settings</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

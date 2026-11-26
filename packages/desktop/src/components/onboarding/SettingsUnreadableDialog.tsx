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
  modal,
}: {
  error: unknown;
  retry: () => void;
  busy: boolean;
  openSettings: () => void;
  modal: boolean;
}): React.JSX.Element {
  const title = "Cadencr can't read your settings";
  const instructions = "Fix or replace the settings file, then retry.";
  const recovery = (
    <>
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
    </>
  );
  if (!modal) {
    return (
      <section
        aria-label={title}
        className="fixed left-4 right-4 top-14 z-50 flex max-w-sm flex-col gap-2 rounded-md border border-border bg-background p-3 text-sm"
      >
        <p className="font-semibold">{title}</p>
        <p className="text-muted-foreground">{instructions}</p>
        {recovery}
      </section>
    );
  }
  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className="sm:max-w-xl"
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Setup and preferences stay on hold until the settings file can be read. {instructions}
          </DialogDescription>
        </DialogHeader>
        {recovery}
      </DialogContent>
    </Dialog>
  );
}

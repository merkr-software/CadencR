import { Loader2 } from "lucide-react";
import type { TelemetryState } from "@/api/telemetry";
import { apiErrorMessage } from "@/lib/api-errors";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { TelemetryChoices } from "./TelemetryChoices";

export function TelemetryDecisionDialog({
  state,
  error,
  retry,
  busy,
}: {
  state?: TelemetryState;
  error?: unknown;
  retry: () => void;
  busy: boolean;
}): React.JSX.Element {
  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>Help improve Cadencr</DialogTitle>
          <DialogDescription>
            Optional reports help fix crashes and improve Cadencr.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-destructive">
              {apiErrorMessage(error, "Could not load privacy preferences.")} Connect to the local
              service and retry to continue.
            </p>
            <Button variant="outline" disabled={busy} onClick={retry}>
              Retry
            </Button>
          </div>
        ) : state ? (
          <TelemetryChoices state={state} />
        ) : (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading privacy preferences…
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

import { useUiTranslation } from "@/lib/i18n/ui";
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
  const { t } = useUiTranslation();
  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        className="max-h-[min(90dvh,var(--dialog-max-h))] sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>{t("telemetry.consent.title", "Help improve Cadencr")}</DialogTitle>
          <DialogDescription>
            {t(
              "telemetry.consent.description",
              "Optional reports help fix crashes and improve Cadencr.",
            )}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-destructive">
              {apiErrorMessage(
                error,
                t("telemetry.consent.loadError", "Could not load privacy preferences."),
              )}{" "}
              {t(
                "telemetry.consent.retryHint",
                "Connect to the local service and retry to continue.",
              )}
            </p>
            <Button variant="outline" disabled={busy} onClick={retry}>
              {t("common.retry", "Retry")}
            </Button>
          </div>
        ) : state ? (
          <TelemetryChoices state={state} />
        ) : (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t("telemetry.consent.loading", "Loading privacy preferences…")}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

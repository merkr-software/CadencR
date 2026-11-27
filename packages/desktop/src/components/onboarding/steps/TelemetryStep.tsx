import { useUiTranslation } from "@/lib/i18n/ui";
import { needsTelemetryDecision, type TelemetryState } from "@/api/telemetry";
import { TelemetryChoices } from "@/components/telemetry/TelemetryChoices";
import { Button } from "@/components/ui/button";

export function TelemetryStep({
  state,
  disabled,
  onContinue,
}: {
  state: TelemetryState;
  disabled: boolean;
  onContinue: () => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">
          {t("telemetry.consent.title", "Help improve Cadencr")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "telemetry.consent.description",
            "Optional reports help fix crashes and improve Cadencr.",
          )}
        </p>
      </header>
      {needsTelemetryDecision(state) ? (
        <TelemetryChoices state={state} disabled={disabled} onSaved={onContinue} />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {t(
              "telemetry.consent.saved",
              "Your detailed telemetry choices are saved. You can change them in Settings.",
            )}
          </p>
          <Button disabled={disabled} onClick={onContinue}>
            {t("common.continue", "Continue")}
          </Button>
        </>
      )}
    </div>
  );
}

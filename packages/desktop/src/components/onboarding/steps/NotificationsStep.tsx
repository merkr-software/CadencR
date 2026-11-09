import { useState } from "react";
import { useGetWorkspaceSetting } from "@/api/generated";
import { useNotchCapabilities } from "@/components/notch/useNotchCapabilities";
import { NotificationModeOptions } from "@/components/settings/NotificationModePicker";
import { Skeleton } from "@/components/ui/skeleton";
import { useSettingWriter } from "@/hooks/useSetting";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  NOTIFICATION_MODE_KEY,
  parseNotificationMode,
  type NotificationMode,
} from "@/lib/notification-mode";
import { OnboardingFooter } from "../OnboardingFooter";
import type { OnboardingStepProps } from "../OnboardingOverlay";

/**
 * Step 5 — where Cadencr tells the user an agent finished or needs them. The
 * notch island is only suggested when a notched display is connected;
 * elsewhere the suggestion is system notifications. Nothing is saved until
 * Continue, so the user confirms the pick; Skip keeps whatever is stored (or
 * the app default).
 */
export function NotificationsStep({
  isPersisting,
  onAdvance,
  onBack,
  onSkipStep,
}: OnboardingStepProps) {
  const capabilities = useNotchCapabilities();
  const modeSetting = useGetWorkspaceSetting(NOTIFICATION_MODE_KEY);
  const writer = useSettingWriter(NOTIFICATION_MODE_KEY);
  const [picked, setPicked] = useState<NotificationMode | null>(null);

  const loading = capabilities.isPending || modeSetting.isPending;
  const hasNotch = capabilities.data?.hardware === true;
  const recommended: NotificationMode = hasNotch ? "notch" : "native";
  const stored = modeSetting.data?.value ?? null;
  const choice = picked ?? (stored == null ? recommended : parseNotificationMode(stored));

  const confirm = async (): Promise<void> => {
    // A failed save is toasted by the writer; staying on the step lets the user retry.
    if (stored !== choice && !(await writer.setValue(choice))) return;
    onAdvance();
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void confirm();
      }}
      className="flex flex-col gap-6"
    >
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">How should agents reach you?</h2>
        <p className="text-sm text-muted-foreground">
          Cadencr lets you know when an agent finishes or needs your input.{" "}
          {hasNotch ? "Your Mac has a notch, so agents can live right inside it. " : null}
          Pick a destination — you can change it any time in Settings → Notifications.
        </p>
      </header>

      {loading ? (
        <div
          className="flex flex-col gap-2"
          aria-busy="true"
          aria-label="Loading notification options"
        >
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-16 w-full rounded-[10px]" />
          ))}
        </div>
      ) : modeSetting.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn't load your notification setting:{" "}
          {apiErrorMessage(modeSetting.error, String(modeSetting.error))}
        </p>
      ) : (
        <NotificationModeOptions value={choice} onChange={setPicked} recommended={recommended} />
      )}

      {capabilities.isError ? (
        <p role="alert" className="text-xs text-destructive">
          Couldn't check this Mac for a notch:{" "}
          {apiErrorMessage(capabilities.error, String(capabilities.error))}
        </p>
      ) : null}

      <OnboardingFooter
        primaryLabel={writer.isSaving ? "Saving…" : "Continue"}
        primaryDisabled={isPersisting || loading || writer.isSaving || modeSetting.isError}
        onBack={onBack}
        onSkipStep={onSkipStep}
      />
    </form>
  );
}

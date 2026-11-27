import { formattingLocale } from "@/lib/i18n/formatting-locale";
import { formatExactNumber } from "@/lib/format-number";
import { useUiTranslation } from "@/lib/i18n/ui";
import type { ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRestartResumeEnabled } from "@/lib/restart-resume-setting";
import { useLiveTotalWorkingCount } from "@/stores/session-status-selectors";
import { useUpdateStore } from "@/stores/update-store";

/**
 * What installing a downloaded update does to the agents that are working:
 * the restart stops them, and Cadencr resumes them on its next start unless
 * the user turned that off. `null` when no agent is working.
 */
export function UpdateInstallNotice(): ReactElement | null {
  const { t, i18n } = useUiTranslation();
  const working = useLiveTotalWorkingCount();
  const formattedCount = formatExactNumber(working, formattingLocale(i18n.language));
  const waiting = useUpdateStore((s) => s.installWhenAgentsFinish);
  const { enabled: resumeEnabled } = useRestartResumeEnabled();

  if (waiting) {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {working > 0
          ? t(
              "updates.waitingForAgents",
              "Cadencr restarts to update once the {{formattedCount}} working agents finish.",
              {
                count: working,
                formattedCount,
                defaultValue_zero:
                  "Cadencr restarts to update once the {{formattedCount}} working agents finish.",
                defaultValue_one: "Cadencr restarts to update once the working agent finishes.",
                defaultValue_other:
                  "Cadencr restarts to update once the {{formattedCount}} working agents finish.",
              },
            )
          : t("updates.restarting", "Restarting to update…")}
      </p>
    );
  }
  if (working === 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {resumeEnabled
        ? t(
            "updates.agentsResume",
            "{{formattedCount}} agents are working. Restarting now interrupts them, and Cadencr resumes them automatically after the update.",
            {
              count: working,
              formattedCount,
              defaultValue_zero:
                "{{formattedCount}} agents are working. Restarting now interrupts them, and Cadencr resumes them automatically after the update.",
              defaultValue_one:
                "{{formattedCount}} agent is working. Restarting now interrupts it, and Cadencr resumes it automatically after the update.",
              defaultValue_other:
                "{{formattedCount}} agents are working. Restarting now interrupts them, and Cadencr resumes them automatically after the update.",
            },
          )
        : t(
            "updates.agentsStop",
            "{{formattedCount}} agents are working. Restarting now stops them, and automatic resume is off, so you will need to continue them yourself.",
            {
              count: working,
              formattedCount,
              defaultValue_zero:
                "{{formattedCount}} agents are working. Restarting now stops them, and automatic resume is off, so you will need to continue them yourself.",
              defaultValue_one:
                "{{formattedCount}} agent is working. Restarting now stops it, and automatic resume is off, so you will need to continue it yourself.",
              defaultValue_other:
                "{{formattedCount}} agents are working. Restarting now stops them, and automatic resume is off, so you will need to continue them yourself.",
            },
          )}
    </p>
  );
}

/**
 * Install buttons for a downloaded update. With agents working, the user can
 * restart now (Cadencr resumes them) or let the update wait until the last
 * agent finishes its turn.
 */
export function UpdateInstallActions({
  size = "default",
}: {
  size?: "sm" | "default";
}): ReactElement {
  const { t } = useUiTranslation();
  const working = useLiveTotalWorkingCount();
  const version = useUpdateStore((s) => s.version);
  const waiting = useUpdateStore((s) => s.installWhenAgentsFinish);
  const installUpdate = useUpdateStore((s) => s.installUpdate);
  const schedule = useUpdateStore((s) => s.scheduleInstallWhenAgentsFinish);
  const cancel = useUpdateStore((s) => s.cancelInstallWhenAgentsFinish);
  // The main process holds the wish: the buttons wait for it to answer.
  const wishPending = useUpdateStore((s) => s.installWishPending);
  const wishSpinner = wishPending ? (
    <Loader2 className="size-3.5 animate-spin" aria-hidden />
  ) : null;

  if (waiting) {
    return (
      <>
        <Button size={size} variant="outline" disabled={wishPending} onClick={() => void cancel()}>
          {wishSpinner}
          {t("common.cancel", "Cancel")}
        </Button>
        <Button size={size} onClick={() => void installUpdate()}>
          {t("system.updateInstallActions.restartNow", "Restart now")}
        </Button>
      </>
    );
  }
  if (working > 0) {
    return (
      <>
        <Button
          size={size}
          variant="outline"
          disabled={wishPending}
          onClick={() => void schedule()}
        >
          {wishSpinner}
          {t("updates.restartAfterAgents", "Restart when agents finish")}
        </Button>
        <Button size={size} onClick={() => void installUpdate()}>
          {t("system.updateInstallActions.restartNow", "Restart now")}
        </Button>
      </>
    );
  }
  return (
    <Button size={size} onClick={() => void installUpdate()}>
      {size === "sm" && version
        ? t("sidebar.updateButton.restartToInstallVersion", "Restart to install v{{version}}", {
            version,
          })
        : t("updates.restartToInstall", "Restart to install")}
    </Button>
  );
}

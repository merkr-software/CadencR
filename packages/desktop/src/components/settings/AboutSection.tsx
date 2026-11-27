import { formattingLocale } from "@/lib/i18n/formatting-locale";
import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import { TelemetrySection } from "./TelemetrySection";
import { ExportDiagnosticsButton } from "../ExportDiagnosticsButton";
import { GitVersionRow } from "./GitVersionRow";
import { CadencrLogo } from "@/components/CadencrLogo";
import { UpdateInstallActions, UpdateInstallNotice } from "@/components/UpdateInstallActions";
import { Button } from "@/components/ui/button";
import { toastError } from "@/lib/api-errors";
import { APP_VERSION } from "@/lib/app-version";
import { desktopBridge } from "@/lib/desktop-bridge";
import { updateStatusMessage } from "@/lib/update-status-message";
import { useUpdateStore } from "@/stores/update-store";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./SettingsRow";
import { SettingsPageSection } from "./SettingsPageSection";
import { SettingsSubsection } from "./SettingsSubsection";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";

export function AboutSection(): React.JSX.Element {
  const { t, i18n } = useUiTranslation();
  const isDesktop = desktopBridge.isElectron;
  const status = useUpdateStore((s) => s.status);
  const updateVersion = useUpdateStore((s) => s.version);
  const progress = useUpdateStore((s) => s.progress);
  const error = useUpdateStore((s) => s.error);
  const unsupportedReason = useUpdateStore((s) => s.unsupportedReason);
  const unsupportedMessage = useUpdateStore((s) => s.unsupportedMessage);
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates);
  const checking = status === "checking" || status === "downloading";
  const unsupported = status === "unsupported";
  const statusMessage = updateStatusMessage(
    status,
    {
      progress,
      version: updateVersion,
      error,
      unsupportedReason,
      unsupportedMessage,
    },
    t,
    formattingLocale(i18n.language),
  );

  return (
    <SettingsPageSection pageId="about">
      <SettingsGroup title={t("system.aboutSection.version", "Version")}>
        <SettingsSubsection>
          <div className="flex items-center gap-4">
            <div className="grid size-12 shrink-0 place-items-center">
              <CadencrLogo className="size-12" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold">Cadencr Desktop</div>
              <div className="font-mono text-xs text-muted-foreground">v{APP_VERSION}</div>
            </div>
            {isDesktop && (
              <div className="flex items-center gap-2">
                {status === "downloaded" ? (
                  <UpdateInstallActions size="sm" />
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={checking || unsupported}
                    onClick={() =>
                      checkForUpdates().catch((err: unknown) =>
                        toastError(
                          err,
                          translateUi("cli.update.error", "Could not check for updates."),
                        ),
                      )
                    }
                    title={unsupported ? statusMessage : undefined}
                  >
                    {unsupported
                      ? unsupportedReason === "dev-build"
                        ? t("updates.unavailable", "Updates unavailable")
                        : t("updates.managedByPackageManager", "Managed by package manager")
                      : status === "downloading"
                        ? t("sidebar.updateButton.downloading", "Downloading…")
                        : checking
                          ? t("updates.checkingShort", "Checking…")
                          : t("updates.checkAction", "Check for updates")}
                  </Button>
                )}
              </div>
            )}
          </div>
          {isDesktop && (
            <div role="status" aria-live="polite" className="mt-3 text-xs text-muted-foreground">
              {statusMessage}
            </div>
          )}
          {isDesktop && status === "downloaded" && (
            <div className="mt-2">
              <UpdateInstallNotice />
            </div>
          )}
        </SettingsSubsection>
      </SettingsGroup>
      <TelemetrySection />
      <SettingsGroup
        id={SETTINGS_ANCHORS.diagnostics}
        title={t("system.aboutSection.diagnostics", "Diagnostics")}
      >
        <SettingsRow
          align="start"
          label={t("system.aboutSection.diagnosticReport", "Diagnostic report")}
          description={t(
            "system.aboutSection.recentErrorsAndAppActivityKeptAcross",
            "Recent errors and app activity, kept across restarts, to help investigate a problem. The report is saved on this computer for you to share.",
          )}
          control={<ExportDiagnosticsButton />}
        />
        <GitVersionRow />
      </SettingsGroup>
    </SettingsPageSection>
  );
}

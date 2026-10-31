import { ExportDiagnosticsButton } from "../ExportDiagnosticsButton";
import { CadencrLogo } from "@/components/CadencrLogo";
import { UpdateInstallActions, UpdateInstallNotice } from "@/components/UpdateInstallActions";
import { Button } from "@/components/ui/button";
import { APP_VERSION } from "@/lib/app-version";
import { desktopBridge } from "@/lib/desktop-bridge";
import { useUpdateStore, type UpdateStatus } from "@/stores/update-store";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./SettingsRow";
import { SettingsPageSection } from "./SettingsPageSection";
import { SettingsSubsection } from "./SettingsSubsection";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";

export function AboutSection(): React.JSX.Element {
  const isDesktop = desktopBridge.isElectron;
  const status = useUpdateStore((s) => s.status);
  const updateVersion = useUpdateStore((s) => s.version);
  const progress = useUpdateStore((s) => s.progress);
  const error = useUpdateStore((s) => s.error);
  const unsupportedMessage = useUpdateStore((s) => s.unsupportedMessage);
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates);
  const checking = status === "checking" || status === "downloading";
  const unsupported = status === "unsupported";

  return (
    <SettingsPageSection pageId="about">
      <SettingsGroup title="Version">
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
                    onClick={() => void checkForUpdates()}
                    title={unsupported ? (unsupportedMessage ?? undefined) : undefined}
                  >
                    {unsupported
                      ? "Managed by package manager"
                      : checking
                        ? "Checking…"
                        : "Check for updates"}
                  </Button>
                )}
              </div>
            )}
          </div>
          {isDesktop && (
            <div role="status" aria-live="polite" className="mt-3 text-xs text-muted-foreground">
              {updateStatusMessage(status, {
                progress,
                version: updateVersion,
                error,
                unsupportedMessage,
              })}
            </div>
          )}
          {isDesktop && status === "downloaded" && (
            <div className="mt-2">
              <UpdateInstallNotice />
            </div>
          )}
        </SettingsSubsection>
      </SettingsGroup>
      <SettingsGroup id={SETTINGS_ANCHORS.diagnostics} title="Diagnostics">
        <SettingsRow
          align="start"
          label="Diagnostic report"
          description="Recent errors and app activity, kept across restarts, to help investigate a problem. The report is saved on this computer for you to share."
          control={<ExportDiagnosticsButton />}
        />
      </SettingsGroup>
    </SettingsPageSection>
  );
}

function updateStatusMessage(
  status: UpdateStatus,
  detail: {
    progress: number;
    version: string | null;
    error: string | null;
    unsupportedMessage: string | null;
  },
): string {
  switch (status) {
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return `Downloading update${detail.version ? ` v${detail.version}` : ""}… ${Math.round(detail.progress)}%`;
    case "downloaded":
      return `Update v${detail.version ?? ""} ready. Restart to install.`;
    case "up-to-date":
      return "You're on the latest version.";
    case "available":
      return `Update v${detail.version ?? ""} available.`;
    case "error":
      return detail.error ? `Update check failed: ${detail.error}` : "Update check failed.";
    case "unsupported":
      return detail.unsupportedMessage ?? "In-app updates are unavailable for this install.";
    case "idle":
    default:
      return "";
  }
}

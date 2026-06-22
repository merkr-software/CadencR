import { CadencrLogo } from "@/components/CadencrLogo";
import { Button } from "@/components/ui/button";
import { APP_VERSION } from "@/lib/app-version";
import { desktopBridge } from "@/lib/desktop-bridge";
import { useUpdateStore, type UpdateStatus } from "@/stores/update-store";
import { SettingsCard } from "./SettingsCard";
import { SettingsSection } from "./SettingsSection";

export function AboutSection(): React.JSX.Element {
  const isDesktop = desktopBridge.isElectron;
  const status = useUpdateStore((s) => s.status);
  const updateVersion = useUpdateStore((s) => s.version);
  const progress = useUpdateStore((s) => s.progress);
  const error = useUpdateStore((s) => s.error);
  const checkForUpdates = useUpdateStore((s) => s.checkForUpdates);
  const installUpdate = useUpdateStore((s) => s.installUpdate);
  const checking = status === "checking" || status === "downloading";

  return (
    <SettingsSection id="about" title="About" subtitle="Build · Diagnostics">
      <SettingsCard padded>
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
                <Button size="sm" onClick={() => void installUpdate()}>
                  Restart to install v{updateVersion ?? ""}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={checking}
                  onClick={() => void checkForUpdates()}
                >
                  {checking ? "Checking…" : "Check for updates"}
                </Button>
              )}
            </div>
          )}
        </div>
        {isDesktop && (
          <div role="status" aria-live="polite" className="mt-3 text-xs text-muted-foreground">
            {updateStatusMessage(status, { progress, version: updateVersion, error })}
          </div>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function updateStatusMessage(
  status: UpdateStatus,
  detail: { progress: number; version: string | null; error: string | null },
): string {
  switch (status) {
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return `Downloading update${detail.version ? ` v${detail.version}` : ""}… ${Math.round(detail.progress)}%`;
    case "downloaded":
      return `Update v${detail.version ?? ""} ready — restart to install.`;
    case "up-to-date":
      return "You're on the latest version.";
    case "available":
      return `Update v${detail.version ?? ""} available.`;
    case "error":
      return detail.error ? `Update check failed: ${detail.error}` : "Update check failed.";
    case "idle":
    default:
      return "";
  }
}

import { useUiTranslation } from "@/lib/i18n/ui";
import { useState } from "react";
import { DownloadIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { desktopBridge } from "@/lib/desktop-bridge";
import { captureDiagnosticContext } from "@/lib/renderer-diagnostics";

export function ExportDiagnosticsButton() {
  const { t } = useUiTranslation();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<
    { kind: "success" } | { kind: "error"; detail?: string } | null
  >(null);
  const exportReport = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const result = await desktopBridge.exportRendererDiagnostics(captureDiagnosticContext());
      if (!result.canceled) setStatus({ kind: "success" });
    } catch (error) {
      setStatus({
        kind: "error",
        detail: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-start gap-2">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void exportReport()}>
        {busy ? (
          <Loader2Icon className="size-4 animate-spin" />
        ) : (
          <DownloadIcon className="size-4" />
        )}
        {busy
          ? t("diagnostics.export.inProgress", "Exporting…")
          : t("diagnostics.export.action", "Export diagnostic report")}
      </Button>
      {status && (
        <p
          role={status.kind === "error" ? "alert" : "status"}
          className={
            status.kind === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"
          }
        >
          {status.kind === "success"
            ? t("diagnostics.export.success", "Diagnostic report exported")
            : (status.detail ?? t("diagnostics.export.failure", "Could not export diagnostics"))}
        </p>
      )}
    </div>
  );
}

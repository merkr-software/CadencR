import { useState } from "react";
import { DownloadIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { desktopBridge } from "@/lib/desktop-bridge";
import { captureDiagnosticContext } from "@/lib/renderer-diagnostics";

export function ExportDiagnosticsButton() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "success" | "error"; message: string } | null>(null);
  const exportReport = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const result = await desktopBridge.exportRendererDiagnostics(captureDiagnosticContext());
      if (!result.canceled) setStatus({ kind: "success", message: "Diagnostic report exported" });
    } catch (error) {
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not export diagnostics",
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
        {busy ? "Exporting…" : "Export diagnostic report"}
      </Button>
      {status && (
        <p
          role={status.kind === "error" ? "alert" : "status"}
          className={
            status.kind === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"
          }
        >
          {status.message}
        </p>
      )}
    </div>
  );
}

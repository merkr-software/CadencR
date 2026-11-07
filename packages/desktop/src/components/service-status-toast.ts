import { toast } from "sonner";
import { RESET_TOAST_STAGE } from "@/lib/staged-toast";
import { desktopBridge } from "@/lib/desktop-bridge";
import type { ServiceStatus } from "@/shared/service-status";

const TOAST_ID = "service-status";

let announced = false;

/** The exit line, plus the service's last words when it printed any. */
export function serviceDownSummary(detail: string): string {
  const lines = detail
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "Last log lines:");
  if (lines.length <= 1) return lines[0] ?? "The service stopped unexpectedly.";
  return `${lines[0]} ${lines[lines.length - 1]}`;
}

function restartService(): void {
  // Main publishes each stage, failures included; only a refusal lands here.
  desktopBridge.restartService().catch((error: unknown) =>
    showServiceStatus({
      state: "down",
      detail: error instanceof Error ? error.message : String(error),
    }),
  );
}

/**
 * The packaged service's state as one staged toast: why it stopped with a
 * Restart action, the restart in progress, then that it is back.
 */
export function showServiceStatus(status: ServiceStatus): void {
  if (status.state === "running") {
    if (!announced) return;
    announced = false;
    toast.success("Cadencr's service is running again", { ...RESET_TOAST_STAGE, id: TOAST_ID });
    return;
  }
  announced = true;
  if (status.state === "restarting") {
    toast.loading("Restarting Cadencr's service…", { ...RESET_TOAST_STAGE, id: TOAST_ID });
    return;
  }
  toast.error("Cadencr's service stopped", {
    ...RESET_TOAST_STAGE,
    id: TOAST_ID,
    description: `${serviceDownSummary(status.detail)} Cadencr can't reach it until it restarts.`,
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: "Restart",
      onClick: (event) => {
        // The click would otherwise delete this id, taking the restart's own stages with it.
        event.preventDefault();
        restartService();
      },
    },
  });
}

export function resetServiceStatusToastForTests(): void {
  announced = false;
}

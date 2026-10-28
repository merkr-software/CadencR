import type { ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRestartResumeEnabled } from "@/lib/restart-resume-setting";
import { useLiveTotalWorkingCount } from "@/stores/session-status-selectors";
import { useUpdateStore } from "@/stores/update-store";

function agents(count: number): string {
  return count === 1 ? "1 agent is" : `${count} agents are`;
}

/**
 * What installing a downloaded update does to the agents that are working:
 * the restart stops them, and Cadencr resumes them on its next start unless
 * the user turned that off. `null` when no agent is working.
 */
export function UpdateInstallNotice(): ReactElement | null {
  const working = useLiveTotalWorkingCount();
  const waiting = useUpdateStore((s) => s.installWhenAgentsFinish);
  const { enabled: resumeEnabled } = useRestartResumeEnabled();

  if (waiting) {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {working > 0
          ? `Cadencr restarts to update once ${working === 1 ? "the working agent finishes" : `the ${working} working agents finish`}.`
          : "Restarting to update…"}
      </p>
    );
  }
  if (working === 0) return null;
  const them = working === 1 ? "it" : "them";
  return (
    <p className="text-xs text-muted-foreground">
      {resumeEnabled
        ? `${agents(working)} working. Restarting now interrupts ${them}, and Cadencr resumes ${them} automatically after the update.`
        : `${agents(working)} working. Restarting now stops ${them}, and automatic resume is off, so you will need to continue ${them} yourself.`}
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
  const working = useLiveTotalWorkingCount();
  const version = useUpdateStore((s) => s.version);
  const waiting = useUpdateStore((s) => s.installWhenAgentsFinish);
  const installUpdate = useUpdateStore((s) => s.installUpdate);
  const schedule = useUpdateStore((s) => s.scheduleInstallWhenAgentsFinish);
  const cancel = useUpdateStore((s) => s.cancelInstallWhenAgentsFinish);

  if (waiting) {
    return (
      <>
        <Button size={size} variant="outline" onClick={cancel}>
          Cancel
        </Button>
        <Button size={size} onClick={() => void installUpdate()}>
          Restart now
        </Button>
      </>
    );
  }
  if (working > 0) {
    return (
      <>
        <Button size={size} variant="outline" onClick={schedule}>
          Restart when agents finish
        </Button>
        <Button size={size} onClick={() => void installUpdate()}>
          Restart now
        </Button>
      </>
    );
  }
  return (
    <Button size={size} onClick={() => void installUpdate()}>
      {size === "sm" ? `Restart to install v${version ?? ""}` : "Restart to install"}
    </Button>
  );
}

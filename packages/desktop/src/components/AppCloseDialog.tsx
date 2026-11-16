import type { ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AppCloseState, WorkingAgent } from "@/hooks/useAppClose";
import { useRestartResumeEnabled } from "@/lib/restart-resume-setting";

function working(count: number): string {
  return count === 1 ? "1 agent is still working" : `${count} agents are still working`;
}

function description(count: number, quitting: boolean, resumeEnabled: boolean): string {
  if (!quitting) return `${working(count)}. It keeps working while Cadencr stays in the Dock.`;
  if (resumeEnabled) {
    return `${working(count)}. Cadencr can pick ${count === 1 ? "it" : "them"} back up where ${count === 1 ? "it" : "they"} left off the next time it starts.`;
  }
  return `${working(count)}. Quitting stops ${count === 1 ? "it" : "them"}, and resuming agents after a restart is turned off in Settings.`;
}

function AgentList({ agents }: { agents: readonly WorkingAgent[] }): ReactElement {
  return (
    <ul className="space-y-1.5 rounded-md border border-border/70 px-3 py-2.5 text-sm">
      {agents.map((agent) => (
        <li key={agent.sessionId} className="flex min-w-0 items-center gap-2">
          <Loader2 className="size-3.5 shrink-0 animate-spin text-blue-500" aria-hidden />
          <span className="truncate text-foreground">{agent.label}</span>
          {agent.waitingOnYou && (
            <span className="shrink-0 text-xs text-muted-foreground">waiting on you</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Confirms closing while agents are working. Quitting stops them; by default
 * Cadencr resumes them on its next start, and the user can stop them instead.
 * Closing the window on macOS stops nothing: the app keeps running.
 */
export function AppCloseDialog({ state }: { state: AppCloseState }): ReactElement | null {
  // Mounted only while open: the root must not subscribe to the setting.
  if (!state.request) return null;
  return <OpenAppCloseDialog state={state} quitting={state.request.quitting} />;
}

function OpenAppCloseDialog({
  state,
  quitting,
}: {
  state: AppCloseState;
  quitting: boolean;
}): ReactElement {
  const { enabled: resumeEnabled } = useRestartResumeEnabled();
  const { agents, cancel, close } = state;
  const stop = () => close({ resumeAgents: false });
  const resume = () => close({ resumeAgents: true });

  return (
    <Dialog open onOpenChange={(open) => !open && cancel()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{quitting ? "Quit Cadencr?" : "Close the window?"}</DialogTitle>
          <DialogDescription>
            {description(agents.length, quitting, resumeEnabled)}
          </DialogDescription>
        </DialogHeader>
        <AgentList agents={agents} />
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          {!quitting ? (
            <Button autoFocus onClick={resume}>
              Close window
            </Button>
          ) : resumeEnabled ? (
            <>
              <Button variant="outline" onClick={stop}>
                Stop agents and quit
              </Button>
              <Button autoFocus onClick={resume}>
                Quit and resume on next launch
              </Button>
            </>
          ) : (
            <Button autoFocus onClick={stop}>
              Stop agents and quit
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

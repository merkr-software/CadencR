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
import type { ActiveCloseWork } from "@/api/generated";
import type { AppCloseState } from "@/hooks/useAppClose";

function working(count: number): string {
  return count === 1 ? "1 agent is still working" : `${count} agents are still working`;
}

function description(count: number | undefined, quitting: boolean): string {
  const work =
    count === undefined ? "Cadencr could not list the active agents." : `${working(count)}.`;
  const effect = quitting
    ? "Quitting stops active turns and the background work Cadencr manages. You can resume them from their conversations."
    : "Active turns and background work continue while Cadencr stays in the Dock.";
  return `${work} ${effect}`;
}

function AgentList({ agents }: { agents: readonly ActiveCloseWork[] }): ReactElement {
  return (
    <ul className="max-h-60 space-y-1.5 overflow-auto rounded-md border border-border/70 px-3 py-2.5 text-sm">
      {agents.map((agent) => (
        <li key={agent.session_id} className="flex min-w-0 items-center gap-2">
          <Loader2 className="size-3.5 shrink-0 animate-spin text-blue-500" aria-hidden />
          <span className="truncate text-foreground">{agent.label}</span>
          {agent.waiting_on_you && (
            <span className="shrink-0 text-xs text-muted-foreground">waiting on you</span>
          )}
          {agent.background_only && (
            <span className="shrink-0 text-xs text-muted-foreground">background work</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Confirms closing while conversations are still working.
 */
export function AppCloseDialog({ state }: { state: AppCloseState }): ReactElement | null {
  if (!state.request) return null;
  const { quitting } = state.request;
  const { agents, cancel, close } = state;

  return (
    <Dialog open onOpenChange={(open) => !open && cancel()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{quitting ? "Quit Cadencr?" : "Close the window?"}</DialogTitle>
          <DialogDescription>{description(agents?.length, quitting)}</DialogDescription>
        </DialogHeader>
        {agents && <AgentList agents={agents} />}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={cancel}>
            Cancel
          </Button>
          <Button onClick={close}>{quitting ? "Stop agents and quit" : "Close window"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

import { useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
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

function description(t: UiTranslator, count: number | undefined, quitting: boolean): string {
  const work =
    count === undefined
      ? t("shell.close.workUnavailable", "Cadencr could not list the active agents.")
      : t("shell.close.working", "{{count}} agents are still working.", {
          count,
          defaultValue_one: "1 agent is still working.",
        });
  const effect = quitting
    ? t(
        "shell.close.stopsWork",
        "Quitting stops active turns and the background work Cadencr manages. You can resume them from their conversations.",
      )
    : t(
        "shell.close.continuesWork",
        "Active turns and background work continue while Cadencr stays in the Dock.",
      );
  return `${work} ${effect}`;
}

function AgentList({ agents }: { agents: readonly ActiveCloseWork[] }): ReactElement {
  const { t } = useUiTranslation();
  return (
    <ul className="max-h-60 space-y-1.5 overflow-auto rounded-md border border-border/70 px-3 py-2.5 text-sm">
      {agents.map((agent) => (
        <li key={agent.session_id} className="flex min-w-0 items-center gap-2">
          <Loader2 className="size-3.5 shrink-0 animate-spin text-blue-500" aria-hidden />
          <span className="truncate text-foreground">
            {agent.label_uses_fallback
              ? t("shell.close.untitled", "Untitled conversation")
              : agent.label}
          </span>
          {agent.waiting_on_you && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {t("shell.close.waiting", "waiting on you")}
            </span>
          )}
          {agent.background_only && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {t("shell.close.backgroundWork", "background work")}
            </span>
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
  return <OpenAppCloseDialog state={state} quitting={state.request.quitting} />;
}

function OpenAppCloseDialog({
  state,
  quitting,
}: {
  state: AppCloseState;
  quitting: boolean;
}): ReactElement {
  const { t } = useUiTranslation();
  const { agents, cancel, close } = state;

  return (
    <Dialog open onOpenChange={(open) => !open && cancel()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {quitting
              ? t("shell.close.quitTitle", "Quit Cadencr?")
              : t("shell.close.windowTitle", "Close the window?")}
          </DialogTitle>
          <DialogDescription>{description(t, agents?.length, quitting)}</DialogDescription>
        </DialogHeader>
        {agents && <AgentList agents={agents} />}
        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" onClick={cancel}>
            {t("common.cancel", "Cancel")}
          </Button>
          <Button onClick={close}>
            {quitting
              ? t("shell.close.stopAndQuit", "Stop agents and quit")
              : t("shell.window.close", "Close window")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

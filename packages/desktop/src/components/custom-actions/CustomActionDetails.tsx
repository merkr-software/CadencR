import type { ReactElement } from "react";
import { ArrowLeftIcon, CalendarClockIcon, PencilIcon, Trash2Icon } from "lucide-react";

import type { CustomAction } from "@/api/generated";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useOpenScheduleEditorForAction } from "@/hooks/useOpenScheduleEditorForAction";
import { useCustomActionsUiStore } from "@/stores/custom-actions-ui-store";
import { CustomActionIcon } from "./CustomActionIcon";
import { CustomActionRunHistory } from "./CustomActionRunHistory";
import { RunStateDot } from "./RunStateDot";

export interface CustomActionDetailsProps {
  actions: readonly CustomAction[];
  action: CustomAction;
  featureId: number;
  projectId: number;
  /** Height of the run output: the popover and the phone sheet size it differently. */
  outputClassName: string;
  onBack: () => void;
  onShowAction: (actionId: number) => void;
  /** Close the menu: a gesture is about to open a dialog or another page. */
  onLeave: () => void;
  onDelete: (action: CustomAction) => void;
}

/**
 * The launcher menu's page for one action: what it runs, its output and runs
 * in this conversation, and its settings (edit, schedule, delete). Any other
 * action is one pick away in the title.
 */
export function CustomActionDetails(props: CustomActionDetailsProps): ReactElement {
  const { action, featureId, projectId, outputClassName, onBack, onLeave } = props;
  return (
    <section aria-label={`${action.name} details`} className="flex min-w-0 flex-col gap-3 p-3">
      <header className="flex flex-wrap items-start gap-1.5">
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground"
          aria-label="All actions"
          title="All actions"
          autoFocus
          onClick={onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-40 flex-1">
          <ActionSwitcher {...props} />
          <p
            className="mt-0.5 truncate px-2 font-mono text-xs text-muted-foreground"
            title={action.command}
          >
            {action.command}
          </p>
        </div>
        <ActionSettings {...props} />
      </header>
      <CustomActionRunHistory
        // Another action starts on its latest run, not the one picked here.
        key={action.id}
        action={action}
        featureId={featureId}
        projectId={projectId}
        outputClassName={outputClassName}
        onLeave={onLeave}
      />
    </section>
  );
}

/** The title doubles as a picker, so every action's runs are reachable from here. */
function ActionSwitcher({ actions, action, onShowAction }: CustomActionDetailsProps) {
  return (
    <Select value={String(action.id)} onValueChange={(value) => onShowAction(Number(value))}>
      <SelectTrigger
        size="sm"
        aria-label="Action to show"
        className="h-8 max-w-full border-transparent px-2 font-semibold shadow-none hover:bg-accent"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        {actions.map((candidate) => (
          <SelectItem key={candidate.id} value={String(candidate.id)}>
            <CustomActionIcon iconData={candidate.icon_data} name={candidate.name} />
            <span className="truncate">{candidate.name}</span>
            {!candidate.run_in_terminal && <RunStateDot run={candidate.last_run} />}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ActionSettings({
  action,
  featureId,
  projectId,
  onLeave,
  onDelete,
}: CustomActionDetailsProps): ReactElement {
  const openScheduleEditor = useOpenScheduleEditorForAction();
  return (
    <div className="ml-auto flex shrink-0 items-center gap-0.5">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          onLeave();
          useCustomActionsUiStore
            .getState()
            .openEditor({ action, projectId, defaultScope: action.scope });
        }}
      >
        <PencilIcon />
        Edit
      </Button>
      {!action.run_in_terminal && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onLeave();
            openScheduleEditor({ projectId, featureId, actionId: action.id });
          }}
        >
          <CalendarClockIcon />
          Schedule…
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground hover:text-[var(--acc-red)]"
        aria-label={`Delete “${action.name}”…`}
        title="Delete…"
        onClick={() => {
          onLeave();
          onDelete(action);
        }}
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}

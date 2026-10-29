import type { ReactElement } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CalendarClockIcon,
  ListVideoIcon,
  PencilIcon,
  PlusIcon,
  Settings2Icon,
  TextCursorInputIcon,
} from "lucide-react";

import type { CustomAction } from "@/api/generated";
import { KbdShortcut } from "@/components/KbdShortcut";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { launchCustomAction, showCustomActionOutput } from "@/lib/custom-actions/launch";
import { runStateText } from "@/lib/custom-actions/run-state";
import { formatCombo } from "@/lib/shortcuts/format";
import { useResolvedShortcut } from "@/lib/shortcuts/overrides";
import { useOpenScheduleEditorForAction } from "@/hooks/useOpenScheduleEditorForAction";
import { useCustomActionsUiStore } from "@/stores/custom-actions-ui-store";
import { CustomActionIcon } from "./CustomActionIcon";
import { RunStateDot } from "./RunStateDot";
import { activateAction } from "./useCustomActionsLauncher";

interface CustomActionsMenuProps {
  actions: readonly CustomAction[];
  selected: CustomAction | null;
  featureId: number;
  projectId: number;
  onDone: () => void;
}

/** ⌥⌘N for the action at `index`, following the user's binding of ⌥⌘1–9. */
function useDigitShortcut(): (index: number) => string[] | null {
  const { keys } = useResolvedShortcut("custom-action-run-1-9");
  return (index) => (index < 9 ? formatCombo([...keys.slice(0, -1), String(index + 1)]) : null);
}

/**
 * The launcher's menu: type to filter, Enter runs. Each row says what its
 * action last did in this conversation; picking a running background action
 * shows its output instead of starting it twice.
 */
export function CustomActionsMenu(props: CustomActionsMenuProps): ReactElement {
  const { actions, featureId, projectId, onDone } = props;
  const digitKeys = useDigitShortcut();
  return (
    <Command loop>
      <CommandInput placeholder="Run an action…" aria-label="Filter actions" />
      <CommandList className="max-h-[min(30rem,70vh)]">
        <CommandEmpty>No action matches.</CommandEmpty>
        {actions.length > 0 && (
          <CommandGroup heading="Run">
            {actions.map((action, index) => {
              const keys = digitKeys(index);
              return (
                <CommandItem
                  key={action.id}
                  value={`${action.name} ${action.id}`}
                  keywords={[action.command]}
                  onSelect={() => {
                    onDone();
                    activateAction(action, featureId, projectId);
                  }}
                >
                  <CustomActionIcon iconData={action.icon_data} name={action.name} />
                  <span className="min-w-0 flex-1 truncate">{action.name}</span>
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <RunStateDot run={action.run_in_terminal ? null : action.last_run} />
                    {action.run_in_terminal ? "Terminal" : runStateText(action.last_run)}
                  </span>
                  {keys && <KbdShortcut keys={keys} variant="inline-sm" />}
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
        <CommandSeparator />
        <MenuCommands {...props} />
      </CommandList>
    </Command>
  );
}

/** What else can be done from the menu, about the selected action or all of them. */
function MenuCommands({
  actions,
  selected,
  featureId,
  projectId,
  onDone,
}: CustomActionsMenuProps): ReactElement {
  const navigate = useNavigate();
  const openScheduleEditor = useOpenScheduleEditorForAction();
  const then = (fn: () => void) => (): void => {
    onDone();
    fn();
  };
  const openEditor = (action?: CustomAction): void =>
    useCustomActionsUiStore
      .getState()
      .openEditor({ action, projectId, defaultScope: action?.scope ?? "project" });
  return (
    <CommandGroup>
      {actions.length > 0 && (
        <CommandItem
          value="show runs"
          onSelect={then(() => showCustomActionOutput(featureId, selected?.id ?? actions[0].id))}
        >
          <ListVideoIcon />
          Show runs
        </CommandItem>
      )}
      {selected && selected.variable_names.length > 0 && (
        <CommandItem
          value={`run ${selected.name} with values`}
          onSelect={then(
            () =>
              void launchCustomAction(
                { action: selected, featureId, projectId },
                { promptVariables: true },
              ),
          )}
        >
          <TextCursorInputIcon />
          Run {selected.name} with…
        </CommandItem>
      )}
      {selected && (
        <CommandItem value={`edit ${selected.name}`} onSelect={then(() => openEditor(selected))}>
          <PencilIcon />
          Edit {selected.name}…
        </CommandItem>
      )}
      {selected && !selected.run_in_terminal && (
        <CommandItem
          value={`schedule ${selected.name}`}
          onSelect={then(() => openScheduleEditor({ projectId, featureId, actionId: selected.id }))}
        >
          <CalendarClockIcon />
          Schedule {selected.name}…
        </CommandItem>
      )}
      <CommandItem value="new action" onSelect={then(() => openEditor())}>
        <PlusIcon />
        New action…
      </CommandItem>
      <CommandItem
        value="manage actions"
        onSelect={then(() => void navigate({ to: "/settings", search: { section: "actions" } }))}
      >
        <Settings2Icon />
        Manage actions…
      </CommandItem>
    </CommandGroup>
  );
}

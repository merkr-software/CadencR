import { memo, useMemo, type ReactElement } from "react";
import { Loader2, MessageSquareText, SquareTerminal } from "lucide-react";
import { useListCustomActions, type Project, type ScheduleTarget } from "@/api/generated";
import { CustomActionIcon } from "@/components/custom-actions/CustomActionIcon";
import { ConversationPicker } from "./ConversationPicker";
import { ProjectPicker } from "./ProjectPicker";
import { PickerPlaceholder, SchedulePicker } from "./SchedulePicker";
import { Field, TargetKindCard } from "./ScheduleTargetEditor";

/**
 * The first choice in the editor: what the schedule *does*. A prompt and a
 * custom action share the rule, the pause/run controls and the history, but
 * not their fields — so the choice comes before everything it hides.
 */
export function ScheduleKindToggle({
  runsAction,
  onChange,
}: {
  runsAction: boolean;
  onChange: (runsAction: boolean) => void;
}): ReactElement {
  return (
    <div className="grid grid-cols-2 gap-2" role="group" aria-label="What the schedule does">
      <TargetKindCard
        selected={!runsAction}
        icon={<MessageSquareText className="size-4" />}
        title="Send a prompt"
        description="An agent works on it at the times you pick"
        onSelect={() => onChange(false)}
      />
      <TargetKindCard
        selected={runsAction}
        icon={<SquareTerminal className="size-4" />}
        title="Run a custom action"
        description="Runs its command in a conversation's working copy"
        onSelect={() => onChange(true)}
      />
    </div>
  );
}

/**
 * The target a kind switch lands on, keeping the project and conversation the
 * user already picked — the most likely place they want the other kind too.
 */
export function switchScheduleKind(
  target: ScheduleTarget,
  runsAction: boolean,
  projects: Project[],
): ScheduleTarget {
  const project_id = target.project_id ?? projects[0]?.id;
  if (runsAction) {
    if (target.kind === "custom_action") return target;
    return {
      kind: "custom_action",
      project_id,
      // A new conversation doesn't exist yet, so there is nothing to keep.
      feature_id: target.kind === "conversation" ? target.feature_id : undefined,
    };
  }
  if (target.kind !== "custom_action") return target;
  return { kind: "conversation", project_id, feature_id: target.feature_id };
}

export interface ScheduleActionEditorProps {
  value: ScheduleTarget;
  onChange: (next: ScheduleTarget) => void;
  projects: Project[];
  /** Title of the already-targeted conversation, shown until the project's
   *  conversations load (or when it has since been archived). */
  targetedConversationTitle?: string | null;
  /** Name of the already-scheduled action, for the same reason. */
  targetedActionName?: string | null;
}

/**
 * Picks which custom action a schedule runs, and in which conversation's
 * working copy — the project narrows both, since an action is either global
 * or belongs to one project.
 */
export const ScheduleActionEditor = memo(function ScheduleActionEditor({
  value,
  onChange,
  projects,
  targetedConversationTitle,
  targetedActionName,
}: ScheduleActionEditorProps): ReactElement {
  return (
    <div className="flex flex-col gap-3">
      <Field label="Project">
        <ProjectPicker
          projects={projects}
          value={value.project_id}
          onChange={(projectId) =>
            onChange({
              ...value,
              project_id: projectId,
              // Both picks belonged to the project we just left (a global
              // action would survive, but re-picking it is one click).
              feature_id: undefined,
              action_id: undefined,
            })
          }
        />
      </Field>
      <Field label="Action">
        <ActionPicker
          projectId={value.project_id}
          actionId={value.action_id}
          fallbackName={targetedActionName}
          onChange={(actionId) => onChange({ ...value, action_id: actionId })}
        />
      </Field>
      <Field
        label="Run in"
        hint="Runs in the background in this conversation's working copy, with the variable values saved there."
      >
        <ConversationPicker
          projectId={value.project_id}
          featureId={value.feature_id}
          fallbackTitle={targetedConversationTitle}
          onChange={(featureId) => onChange({ ...value, feature_id: featureId })}
        />
      </Field>
    </div>
  );
});

function ActionPicker({
  projectId,
  actionId,
  fallbackName,
  onChange,
}: {
  projectId?: number | null;
  actionId?: number | null;
  fallbackName?: string | null;
  onChange: (actionId: number) => void;
}): ReactElement {
  const query = useListCustomActions(
    { project_id: projectId ?? 0 },
    { query: { enabled: projectId != null } },
  );
  const options = useMemo(
    () =>
      (Array.isArray(query.data) ? query.data : []).map((action) => ({
        value: action.id,
        label: action.name,
        icon: (
          <CustomActionIcon
            iconData={action.icon_data ?? null}
            name={action.name}
            className="size-3.5 text-muted-foreground"
          />
        ),
      })),
    [query.data],
  );

  if (projectId == null) {
    return <PickerPlaceholder>Pick a project first.</PickerPlaceholder>;
  }
  if (query.isLoading) {
    return (
      <PickerPlaceholder aria-busy="true">
        <Loader2 className="size-3.5 animate-spin" />
        Loading actions…
      </PickerPlaceholder>
    );
  }
  if (query.isError) {
    return (
      <PickerPlaceholder className="border-destructive/40 text-destructive">
        Could not load this project&apos;s actions.
      </PickerPlaceholder>
    );
  }
  if (options.length === 0) {
    return <PickerPlaceholder>This project has no custom actions yet.</PickerPlaceholder>;
  }
  return (
    <SchedulePicker
      ariaLabel="Action"
      options={options}
      value={actionId}
      fallbackLabel={fallbackName}
      placeholder="Pick an action…"
      searchPlaceholder="Search actions…"
      emptyLabel="No matching actions."
      onChange={onChange}
    />
  );
}

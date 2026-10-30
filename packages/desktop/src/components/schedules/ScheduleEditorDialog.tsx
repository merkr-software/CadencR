import { useCallback, type ReactElement } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KbdShortcut } from "@/components/KbdShortcut";
import { useDialogSubmitShortcut } from "@/components/git-actions/useDialogSubmitShortcut";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PopoverModality } from "@/components/ui/popover";
import { ConditionEditor } from "./ConditionEditor";
import { RecurrenceEditor } from "./RecurrenceEditor";
import {
  ScheduleActionEditor,
  ScheduleKindToggle,
  switchScheduleKind,
} from "./ScheduleActionEditor";
import { ScheduleComposer } from "./ScheduleComposer";
import { Field, ScheduleTargetEditor } from "./ScheduleTargetEditor";
import { useScheduleDraft, type ScheduleDraft, type ScheduleDraftParams } from "./useScheduleDraft";

export type ScheduleEditorDialogProps = ScheduleDraftParams;

// Hoisted so `KbdShortcut`'s `keys` prop stays reference-stable across renders.
const SUBMIT_KEYS: string[] = ["cmd", "enter"];

/**
 * The single schedule editor, used both by the Schedules page and by the
 * composer's "schedule this message" flow. One editor means a schedule created
 * from a conversation is the same object, with the same options, as one created
 * from the page — which is the whole point of unifying the two systems.
 */
export function ScheduleEditorDialog(props: ScheduleEditorDialogProps): ReactElement {
  const { open, onOpenChange, schedule, lockedConversation, projects, onDelete } = props;
  const draft = useScheduleDraft(props);
  const projectPath = projects.find((project) => project.id === draft.target.project_id)?.path;
  const { runsAction } = draft;
  const gated = !runsAction && draft.condition.enabled;

  // Same ⌘/Ctrl+Enter as every other dialog in the app, and as the composer this
  // one embeds. Captured at the document so it works from inside the prompt
  // editor, where a plain Enter is a newline. `save()` is a no-op while the
  // draft is incomplete — the disabled button and the inline errors say why.
  const submitShortcut = useCallback(() => {
    void draft.save();
  }, [draft]);
  useDialogSubmitShortcut({ open, onSubmit: submitShortcut });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Roomy on purpose: this holds a full prompt composer with its own
          pickers, not a form of short fields. `PopoverModality` is what lets
          those pickers' lists scroll — see its docs. */}
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{schedule ? "Edit schedule" : "New schedule"}</DialogTitle>
          <DialogDescription>{describe(runsAction, gated)}</DialogDescription>
        </DialogHeader>

        <PopoverModality>
          <div className="flex flex-col gap-4">
            {/* The composer's own editor only ever schedules its message. */}
            {!lockedConversation && (
              <ScheduleKindToggle
                runsAction={runsAction}
                onChange={(next) =>
                  draft.setTarget(switchScheduleKind(draft.target, next, projects))
                }
              />
            )}

            <Field
              label="Name"
              hint={
                runsAction
                  ? "Optional — falls back to the action's name"
                  : "Optional — falls back to the first line of the prompt"
              }
            >
              <Input
                value={draft.name}
                onChange={(event) => draft.setName(event.target.value)}
                placeholder="Nightly review"
                className="h-8 text-sm"
              />
            </Field>

            {runsAction ? (
              <Section title="Action">
                <ScheduleActionEditor
                  value={draft.target}
                  onChange={draft.setTarget}
                  projects={projects}
                  targetedConversationTitle={schedule?.context.feature_title}
                  targetedActionName={schedule?.context.action_name}
                />
              </Section>
            ) : (
              <PromptSections draft={draft} props={props} projectPath={projectPath} />
            )}

            <Section title="When">
              <RecurrenceEditor
                value={draft.recurrence}
                onChange={draft.setRecurrence}
                now={draft.now}
                evaluatesCommand={gated}
                runsAction={runsAction}
              />
            </Section>

            {!runsAction && (
              <Section title="Condition">
                <ConditionEditor
                  value={draft.condition}
                  onChange={draft.setCondition}
                  targetsExistingConversation={draft.target.kind === "conversation"}
                />
              </Section>
            )}
          </div>
        </PopoverModality>

        <Footer
          draft={draft}
          editing={Boolean(schedule)}
          onDelete={schedule ? onDelete : undefined}
        />
      </DialogContent>
    </Dialog>
  );
}

function describe(runsAction: boolean, gated: boolean): string {
  if (runsAction) {
    return "While Cadencr is running, it runs the action at the times you pick. A run that exits non-zero is listed as failed.";
  }
  return gated
    ? "While Cadencr is running, it runs the command at the times you pick and sends the prompt only when the command fails."
    : "Cadencr sends the prompt at the times you pick, as long as it is running.";
}

/** Where the prompt goes and what it says — everything a prompt schedule has
 *  that an action schedule doesn't. */
function PromptSections({
  draft,
  props,
  projectPath,
}: {
  draft: ScheduleDraft;
  props: ScheduleEditorDialogProps;
  projectPath: string | undefined;
}): ReactElement {
  return (
    <>
      <Section title="Send to">
        <ScheduleTargetEditor
          value={draft.target}
          onChange={draft.setTarget}
          projects={props.projects}
          lockedToConversation={Boolean(props.lockedConversation)}
          targetedConversationTitle={props.schedule?.context.feature_title}
        />
      </Section>

      <Section title="Prompt">
        <div className="flex flex-col gap-1.5">
          <ScheduleComposer
            key={draft.formKey}
            initialPrompt={draft.prompt}
            onPromptChange={draft.setPrompt}
            target={draft.target}
            onTargetChange={draft.setTarget}
            projectPath={projectPath}
          />
          {draft.worktreeError && (
            <p className="text-xs text-destructive" role="alert">
              {draft.worktreeError}
            </p>
          )}
        </div>
      </Section>
    </>
  );
}

function Footer({
  draft,
  editing,
  onDelete,
}: {
  draft: ScheduleDraft;
  editing: boolean;
  onDelete: ScheduleDraftParams["onDelete"];
}): ReactElement {
  return (
    <DialogFooter className="gap-2 sm:justify-between">
      {onDelete ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void draft.remove()}
          disabled={draft.busy}
          className="text-destructive hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
          Delete
        </Button>
      ) : (
        <span />
      )}
      <Button type="button" onClick={() => void draft.save()} disabled={!draft.canSave}>
        {draft.busy && <Loader2 className="size-3.5 animate-spin" />}
        {editing ? "Save" : "Create schedule"}
        <KbdShortcut keys={SUBMIT_KEYS} variant="hint" />
      </Button>
    </DialogFooter>
  );
}

function Section({ title, children }: { title: string; children: ReactElement }): ReactElement {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/30 p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

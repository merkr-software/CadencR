import { useId, useState, type ReactElement } from "react";
import { Trash2Icon } from "lucide-react";

import { BashFrame } from "@/components/BashFrame";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { UsageSegmentedControl } from "@/components/usage/UsageSegmentedControl";
import { useDialogSubmitShortcut } from "@/components/git-actions/useDialogSubmitShortcut";
import {
  useCustomActionsUiStore,
  type CustomActionEditorRequest,
} from "@/stores/custom-actions-ui-store";
import { ActionIconPicker } from "./ActionIconPicker";
import { DeleteCustomActionDialog } from "./DeleteCustomActionDialog";
import {
  useCustomActionEditorForm,
  type CustomActionEditorForm,
} from "./useCustomActionEditorForm";

/**
 * The one action editor, opened from the launcher menu (its list and an
 * action's page) and both settings lists through `useCustomActionsUiStore.openEditor`. Mounted
 * once at the app root.
 */
export function CustomActionEditorHost(): ReactElement | null {
  const request = useCustomActionsUiStore((state) => state.editor);
  const close = useCustomActionsUiStore((state) => state.closeEditor);
  return (
    <Dialog open={request != null} onOpenChange={(open) => !open && close()}>
      {request && (
        <EditorContent
          key={request.action?.id ?? `new-${request.projectId}`}
          request={request}
          onClose={close}
        />
      )}
    </Dialog>
  );
}

function EditorContent({
  request,
  onClose,
}: {
  request: CustomActionEditorRequest;
  onClose: () => void;
}): ReactElement {
  const editor = useCustomActionEditorForm(request, onClose);
  const [deleting, setDeleting] = useState(false);
  useDialogSubmitShortcut({ open: true, enabled: !editor.isPending, onSubmit: editor.submit });
  return (
    <DialogContent className="sm:max-w-xl">
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          editor.submit();
        }}
        className="space-y-4"
      >
        <DialogHeader>
          <DialogTitle>{request.action ? `Edit ${request.action.name}` : "New action"}</DialogTitle>
          <DialogDescription>
            A command you run often in a conversation&apos;s working copy. Write{" "}
            <code className="font-mono text-xs">${"{NAME}"}</code> where a value changes per
            conversation: it is asked for when you run it.
          </DialogDescription>
        </DialogHeader>
        <NameAndCommandFields editor={editor} />
        <BehaviorFields editor={editor} />
        {editor.errors.submit && (
          <p role="alert" className="text-sm text-destructive">
            {editor.errors.submit}
          </p>
        )}
        <DialogFooter className="items-center sm:justify-between">
          {request.action ? (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(true)}
            >
              <Trash2Icon />
              Delete…
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={editor.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={editor.isPending}>
              {editor.isPending ? "Saving…" : request.action ? "Save" : "Create action"}
            </Button>
          </div>
        </DialogFooter>
      </form>
      <DeleteCustomActionDialog
        action={deleting ? (request.action ?? null) : null}
        onClose={() => setDeleting(false)}
        onDeleted={onClose}
      />
    </DialogContent>
  );
}

function NameAndCommandFields({ editor }: { editor: CustomActionEditorForm }): ReactElement {
  const nameId = useId();
  const commandId = useId();
  const { form, setForm, errors, variables } = editor;
  return (
    <>
      <div className="space-y-1.5">
        <label htmlFor={nameId} className="text-xs font-medium">
          Name
        </label>
        <Input
          id={nameId}
          autoFocus
          value={form.name}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? `${nameId}-error` : undefined}
          onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
          placeholder="Run tests"
        />
        {errors.name && (
          <p id={`${nameId}-error`} className="text-xs text-destructive">
            {errors.name}
          </p>
        )}
      </div>
      <div className="space-y-1.5">
        <label htmlFor={commandId} className="text-xs font-medium">
          Command
        </label>
        <BashFrame>
          <Textarea
            id={commandId}
            value={form.command}
            aria-invalid={errors.command ? true : undefined}
            aria-describedby={`${commandId}-hint`}
            onChange={(event) =>
              setForm((current) => ({ ...current, command: event.target.value }))
            }
            placeholder="pnpm test --filter ${PACKAGE}"
            className="min-h-20 resize-y rounded-none border-0 bg-transparent font-mono text-xs text-[var(--block-bash-fg)] shadow-none placeholder:text-[var(--block-bash-muted-fg)] focus-visible:border-0 focus-visible:ring-0"
          />
        </BashFrame>
        <p
          id={`${commandId}-hint`}
          className={errors.command ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
        >
          {errors.command ??
            (variables.length > 0
              ? `Asked for when you run it: ${variables.join(", ")}`
              : "Runs in the conversation's worktree, through your login shell.")}
        </p>
      </div>
    </>
  );
}

function BehaviorFields({ editor }: { editor: CustomActionEditorForm }): ReactElement {
  const iconId = useId();
  const { form, setForm } = editor;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <fieldset className="space-y-1.5">
        <legend className="mb-1.5 text-xs font-medium">Runs</legend>
        <UsageSegmentedControl
          ariaLabel="Where the action runs"
          className="[&_button]:px-2.5 [&_button]:py-1 [&_button]:text-xs"
          value={form.runInTerminal ? "terminal" : "background"}
          onChange={(value) =>
            setForm((current) => ({ ...current, runInTerminal: value === "terminal" }))
          }
          options={[
            { value: "background", label: "In the background" },
            { value: "terminal", label: "In a terminal" },
          ]}
        />
        <p className="text-xs text-muted-foreground">
          {form.runInTerminal
            ? "Opens a terminal split you can type into — for dev servers and prompts."
            : "Output and status show on its page in the header’s action menu; it can also run on a schedule."}
        </p>
      </fieldset>
      <fieldset className="space-y-1.5">
        <legend className="mb-1.5 text-xs font-medium">Available in</legend>
        {editor.canChooseScope ? (
          <UsageSegmentedControl
            ariaLabel="Where the action is available"
            className="[&_button]:px-2.5 [&_button]:py-1 [&_button]:text-xs"
            value={form.scope}
            onChange={(scope) => setForm((current) => ({ ...current, scope }))}
            options={[
              { value: "project", label: "This project" },
              { value: "global", label: "All projects" },
            ]}
          />
        ) : (
          <p className="text-sm">All projects</p>
        )}
      </fieldset>
      <div className="space-y-1.5 sm:col-span-2">
        <p aria-hidden className="text-xs font-medium">
          Icon
        </p>
        <ActionIconPicker
          id={iconId}
          name={form.name}
          value={form.iconData}
          onChange={(iconData) => setForm((current) => ({ ...current, iconData }))}
        />
      </div>
    </div>
  );
}

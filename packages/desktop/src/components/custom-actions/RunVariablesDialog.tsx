import { useId, useState, type ReactElement } from "react";
import { toast } from "sonner";
import { Loader2Icon, PlayIcon } from "lucide-react";

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
import { apiErrorMessage } from "@/lib/api-errors";
import { missingVariables, saveVariablesAndLaunch } from "@/lib/custom-actions/launch";
import {
  useCustomActionsUiStore,
  type PendingVariablesPrompt,
} from "@/stores/custom-actions-ui-store";

/**
 * Asks for an action's `${VAR}` values right before it runs. Values are kept
 * per conversation and prefilled next time; Run stays disabled until each one
 * is filled, so a run can no longer start only to fail on a missing value.
 */
export function RunVariablesDialogHost(): ReactElement | null {
  const prompt = useCustomActionsUiStore((state) => state.pendingVariables);
  const close = useCustomActionsUiStore((state) => state.closeVariablesPrompt);
  return (
    <Dialog open={prompt != null} onOpenChange={(open) => !open && close()}>
      {prompt && (
        <VariablesForm
          key={`${prompt.target.action.id}:${prompt.target.featureId}`}
          prompt={prompt}
          onClose={close}
        />
      )}
    </Dialog>
  );
}

function VariablesForm({
  prompt,
  onClose,
}: {
  prompt: PendingVariablesPrompt;
  onClose: () => void;
}): ReactElement {
  const { action } = prompt.target;
  const formId = useId();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(action.variable_names.map((name) => [name, prompt.values[name] ?? ""])),
  );
  const [pending, setPending] = useState(false);
  const missing = missingVariables(action.variable_names, values);
  const firstMissing = missing[0] ?? action.variable_names[0];

  const run = async (): Promise<void> => {
    if (missing.length > 0 || pending) return;
    setPending(true);
    try {
      await saveVariablesAndLaunch(prompt.target, values, prompt.values, prompt.showOutput);
      onClose();
    } catch (error) {
      toast.error(
        `Could not save values for ${action.name}: ${apiErrorMessage(error, "unknown error")}`,
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <DialogContent className="sm:max-w-md">
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
        className="space-y-4"
      >
        <DialogHeader>
          <DialogTitle>Run {action.name}</DialogTitle>
          <DialogDescription className="font-mono text-xs break-all">
            {action.command}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {action.variable_names.map((name) => (
            <div key={name} className="space-y-1">
              <label htmlFor={`${formId}-${name}`} className="font-mono text-xs font-medium">
                {name}
              </label>
              <Input
                id={`${formId}-${name}`}
                autoFocus={name === firstMissing}
                value={values[name] ?? ""}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [name]: event.target.value }))
                }
                className="font-mono text-xs"
              />
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Remembered for this conversation.{" "}
            {missing.length > 0 && `Still needed: ${missing.join(", ")}.`}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={missing.length > 0 || pending}>
            {pending ? <Loader2Icon className="animate-spin" /> : <PlayIcon />}
            {pending ? "Starting…" : "Run"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}

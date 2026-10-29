import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { ImageIcon, Trash2Icon } from "lucide-react";

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
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getListCustomActionsQueryKey,
  useCreateCustomAction,
  useUpdateCustomAction,
  type CustomAction,
  type Scope as CustomActionScope,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { BashFrame } from "./BashFrame";
import { CustomActionIcon } from "./CustomActionIcon";

const ACCEPTED_MIME = ["image/png", "image/jpeg", "image/jpg", "image/svg+xml", "image/gif"];
const MAX_ICON_BYTES = 512 * 1024;

interface CustomActionEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: number;
  featureId: number;
  /** When provided, the dialog edits this action; otherwise it creates a new one. */
  action?: CustomAction;
}

interface FormState {
  name: string;
  command: string;
  scope: CustomActionScope;
  iconData: string | null;
  runInTerminal: boolean;
}

const EMPTY_STATE: FormState = {
  name: "",
  command: "",
  scope: "project",
  iconData: null,
  runInTerminal: false,
};

function detectVariables(command: string): string[] {
  const expression = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  const seen = new Set<string>();
  const variables: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = expression.exec(command)) != null) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    variables.push(match[1]);
  }
  return variables;
}

function useCustomActionMutations(props: CustomActionEditorDialogProps) {
  const queryClient = useQueryClient();
  const invalidate = (): void => {
    void queryClient.invalidateQueries({
      queryKey: getListCustomActionsQueryKey({
        project_id: props.projectId,
        feature_id: props.featureId,
      }),
    });
    props.onOpenChange(false);
  };
  const createMutation = useCreateCustomAction({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast.success("Action created");
      },
      onError: (error) => toast.error(`Create failed: ${apiErrorMessage(error, "unknown error")}`),
    },
  });
  const updateMutation = useUpdateCustomAction({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast.success("Action updated");
      },
      onError: (error) => toast.error(`Update failed: ${apiErrorMessage(error, "unknown error")}`),
    },
  });
  return useMemo(() => ({ createMutation, updateMutation }), [createMutation, updateMutation]);
}

function useCustomActionForm(props: CustomActionEditorDialogProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_STATE);
  useEffect(() => {
    if (!props.open) return;
    setForm(
      props.action
        ? {
            name: props.action.name,
            command: props.action.command,
            scope: props.action.scope,
            iconData: props.action.icon_data ?? null,
            runInTerminal: props.action.run_in_terminal,
          }
        : EMPTY_STATE,
    );
  }, [props.action, props.open]);
  const detectedVars = useMemo(() => detectVariables(form.command), [form.command]);
  const mutations = useCustomActionMutations(props);
  const handleFile = useCallback((file: File): void => {
    if (!ACCEPTED_MIME.includes(file.type)) {
      toast.error("Unsupported file type. Use PNG, JPG, GIF or SVG.");
      return;
    }
    if (file.size > MAX_ICON_BYTES) {
      toast.error(`Image too large (${file.size} bytes). Max ${MAX_ICON_BYTES} bytes.`);
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => toast.error("Failed to read image file.");
    reader.onload = () => {
      if (typeof reader.result === "string") {
        setForm((current) => ({ ...current, iconData: reader.result as string }));
      }
    };
    reader.readAsDataURL(file);
  }, []);
  const submit = useCallback((): void => {
    if (!form.name.trim() || !form.command.trim()) {
      toast.error(form.name.trim() ? "Command is required" : "Name is required");
      return;
    }
    const data = {
      name: form.name,
      command: form.command,
      scope: form.scope,
      project_id: form.scope === "global" ? null : props.projectId,
      icon_data: form.iconData,
      run_in_terminal: form.runInTerminal,
    };
    if (props.action) {
      mutations.updateMutation.mutate({
        id: props.action.id,
        data: { ...data, icon_data: form.iconData ?? "" },
      });
    } else {
      mutations.createMutation.mutate({ data });
    }
  }, [form, mutations.createMutation, mutations.updateMutation, props.action, props.projectId]);
  const isPending = mutations.createMutation.isPending || mutations.updateMutation.isPending;
  return useMemo(
    () => ({ detectedVars, fileInputRef, form, handleFile, isPending, setForm, submit }),
    [detectedVars, form, handleFile, isPending, submit],
  );
}

type CustomActionFormController = ReturnType<typeof useCustomActionForm>;

export function CustomActionEditorDialog(props: CustomActionEditorDialogProps) {
  const controller = useCustomActionForm(props);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{props.action ? "Edit custom action" : "New custom action"}</DialogTitle>
          <DialogDescription>
            Commands run in the feature&apos;s working directory. Use{" "}
            <code className="font-mono text-xs">${"{VAR_NAME}"}</code> placeholders to prompt for
            per-feature values.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <CustomActionCommandFields controller={controller} />
          <CustomActionScopeAndIcon controller={controller} />
          <RunInTerminalField controller={controller} />
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => props.onOpenChange(false)}
            disabled={controller.isPending}
          >
            Cancel
          </Button>
          <Button onClick={controller.submit} disabled={controller.isPending}>
            {controller.isPending ? "Saving…" : props.action ? "Save changes" : "Create action"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CustomActionCommandFields({ controller }: { controller: CustomActionFormController }) {
  return (
    <>
      <div className="space-y-1.5">
        <label className="text-xs font-medium">Name</label>
        <Input
          value={controller.form.name}
          onChange={(event) =>
            controller.setForm((form) => ({ ...form, name: event.target.value }))
          }
          placeholder="Open in Zed"
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium">Command</label>
        <BashFrame>
          <Textarea
            value={controller.form.command}
            onChange={(event) =>
              controller.setForm((form) => ({ ...form, command: event.target.value }))
            }
            placeholder="gh pr view ${PR_ID} --json comments"
            className="min-h-[5rem] resize-none rounded-none border-0 bg-transparent font-mono text-xs text-[var(--block-bash-fg)] shadow-none placeholder:text-[var(--block-bash-muted-fg)] focus-visible:border-0 focus-visible:ring-0"
          />
        </BashFrame>
        {controller.detectedVars.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Variables detected:{" "}
            {controller.detectedVars.map((variable) => (
              <code key={variable} className="font-mono mr-1.5">
                ${`{${variable}}`}
              </code>
            ))}
          </p>
        )}
      </div>
    </>
  );
}

function CustomActionScopeAndIcon({ controller }: { controller: CustomActionFormController }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="space-y-1.5">
        <label className="text-xs font-medium">Scope</label>
        <Select
          value={controller.form.scope}
          onValueChange={(value) =>
            controller.setForm((form) => ({ ...form, scope: value as CustomActionScope }))
          }
        >
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="project">This project only</SelectItem>
            <SelectItem value="global">Available on all projects</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium">Icon</label>
        <div className="flex items-center gap-2">
          <div className="flex size-9 items-center justify-center rounded border bg-muted/30">
            <CustomActionIcon
              iconData={controller.form.iconData}
              name={controller.form.name || "icon"}
            />
          </div>
          <input
            ref={controller.fileInputRef}
            type="file"
            accept={ACCEPTED_MIME.join(",")}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) controller.handleFile(file);
              event.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => controller.fileInputRef.current?.click()}
          >
            <ImageIcon className="size-3.5" /> Upload
          </Button>
          {controller.form.iconData && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 text-destructive"
              title="Remove icon"
              onClick={() => controller.setForm((form) => ({ ...form, iconData: null }))}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function RunInTerminalField({ controller }: { controller: CustomActionFormController }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <Checkbox
        checked={controller.form.runInTerminal}
        onCheckedChange={(checked) =>
          controller.setForm((form) => ({ ...form, runInTerminal: checked === true }))
        }
        className="mt-0.5"
      />
      <span className="space-y-0.5">
        <span className="block text-xs font-medium">Run in a dedicated terminal split</span>
        <span className="block text-xs text-muted-foreground">
          Spawn the command in a new terminal pane instead of the background. Best for long-running,
          interactive commands like dev servers.
        </span>
      </span>
    </label>
  );
}

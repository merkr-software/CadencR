import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import {
  getListCustomActionsQueryKey,
  useCreateCustomAction,
  useUpdateCustomAction,
  type Scope,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import type { CustomActionEditorRequest } from "@/stores/custom-actions-ui-store";

export interface CustomActionFormState {
  name: string;
  command: string;
  scope: Scope;
  iconData: string | null;
  runInTerminal: boolean;
}

export interface CustomActionFormErrors {
  name?: true;
  command?: true;
  /** A save the backend refused, shown above the footer. */
  submit?: { cause: unknown };
}

const VARIABLE_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** `${VAR}` names in declaration order, deduplicated (mirrors the service). */
export function detectVariables(command: string): string[] {
  return [...new Set(Array.from(command.matchAll(VARIABLE_PATTERN), (match) => match[1]))];
}

export function validateCustomActionForm(form: CustomActionFormState): CustomActionFormErrors {
  const errors: CustomActionFormErrors = {};
  if (!form.name.trim()) errors.name = true;
  if (!form.command.trim()) errors.command = true;
  return errors;
}

function initialForm(request: CustomActionEditorRequest): CustomActionFormState {
  const { action } = request;
  if (action) {
    return {
      name: action.name,
      command: action.command,
      scope: action.scope,
      iconData: action.icon_data ?? null,
      runInTerminal: action.run_in_terminal,
    };
  }
  return {
    name: "",
    command: "",
    scope: request.projectId == null ? "global" : request.defaultScope,
    iconData: null,
    runInTerminal: false,
  };
}

/**
 * Form state for the action editor. Mounted per opening (keyed by the
 * request), so a reopened editor never shows a previous draft. Errors are
 * shown inline on submit; a refusal from the service lands beside the footer.
 */
export function useCustomActionEditorForm(request: CustomActionEditorRequest, onSaved: () => void) {
  const { t } = useUiTranslation();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CustomActionFormState>(() => initialForm(request));
  const [issues, setErrors] = useState<CustomActionFormErrors>({});
  const variables = useMemo(() => detectVariables(form.command), [form.command]);
  // An action edited outside a project keeps its own project when it stays project-scoped.
  const projectId = request.projectId ?? request.action?.project_id ?? null;

  const onSuccess = (kind: "created" | "saved") => (): void => {
    void queryClient.invalidateQueries({ queryKey: getListCustomActionsQueryKey() });
    const name = form.name.trim();
    toast.success(
      kind === "created"
        ? translateUi("customActions.editor.created", "{{name}} created", { name })
        : translateUi("customActions.editor.saved", "{{name}} saved", { name }),
    );
    onSaved();
  };
  const onError = (error: unknown): void => setErrors({ submit: { cause: error } });
  const create = useCreateCustomAction({ mutation: { onSuccess: onSuccess("created"), onError } });
  const update = useUpdateCustomAction({ mutation: { onSuccess: onSuccess("saved"), onError } });

  const submit = useCallback((): void => {
    const found = validateCustomActionForm(form);
    setErrors(found);
    if (found.name || found.command) return;
    const data = {
      name: form.name.trim(),
      command: form.command,
      scope: form.scope,
      project_id: form.scope === "global" ? null : projectId,
      run_in_terminal: form.runInTerminal,
    };
    if (request.action) {
      // `""` clears a stored icon; omitting it would keep the old one.
      update.mutate({ id: request.action.id, data: { ...data, icon_data: form.iconData ?? "" } });
    } else {
      create.mutate({ data: { ...data, icon_data: form.iconData } });
    }
  }, [create, form, projectId, request.action, update]);

  return {
    form,
    setForm,
    errors: {
      name: issues.name && t("customActions.editor.nameRequired", "Give the action a name."),
      command:
        issues.command && t("customActions.editor.commandRequired", "Enter the command to run."),
      submit:
        issues.submit &&
        apiErrorMessage(
          issues.submit.cause,
          t("customActions.editor.saveError", "the action could not be saved"),
        ),
    },
    variables,
    canChooseScope: projectId != null,
    isPending: create.isPending || update.isPending,
    submit,
  };
}

export type CustomActionEditorForm = ReturnType<typeof useCustomActionEditorForm>;

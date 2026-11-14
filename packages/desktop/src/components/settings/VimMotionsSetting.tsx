import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getGetWorkspaceSettingQueryKey,
  useGetWorkspaceSetting,
  useSetWorkspaceSetting,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { EDITOR_BACKEND_KEY, resolveEditorId } from "@/lib/editors/editor-registry";
import { EDITOR_VIM_MODE_LEVEL_KEY, parseVimModeLevel } from "@/lib/vim-mode-level";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

export function VimMotionsSetting() {
  const client = useQueryClient();
  const backend = useGetWorkspaceSetting(EDITOR_BACKEND_KEY);
  const vim = useGetWorkspaceSetting(EDITOR_VIM_MODE_LEVEL_KEY);
  const { mutateAsync } = useSetWorkspaceSetting();
  const [saving, setSaving] = useState(false);
  const change = (checked: boolean): void => {
    setSaving(true);
    void (async () => {
      try {
        // Pin the legacy editor first: changing motions must not change its identity.
        if (backend.data?.value == null) {
          const value = resolveEditorId(null, vim.data?.value ?? "0");
          await mutateAsync({ key: EDITOR_BACKEND_KEY, data: { value } });
          client.setQueryData(getGetWorkspaceSettingQueryKey(EDITOR_BACKEND_KEY), { value });
        }
        const value = checked ? "1" : "0";
        await mutateAsync({ key: EDITOR_VIM_MODE_LEVEL_KEY, data: { value } });
        client.setQueryData(getGetWorkspaceSettingQueryKey(EDITOR_VIM_MODE_LEVEL_KEY), { value });
      } catch (error: unknown) {
        toast.error(apiErrorMessage(error, "Vim motions could not be saved"));
      } finally {
        setSaving(false);
      }
    })();
  };
  return (
    <SettingsSwitchRow
      label="Vim motions"
      description={
        backend.isError || vim.isError
          ? "Editor settings could not be loaded."
          : saving
            ? "Saving Vim motions…"
            : "Use modal editing in CodeMirror, independently of the selected editor."
      }
      checked={parseVimModeLevel(vim.data?.value) !== "0"}
      disabled={saving || backend.isLoading || vim.isLoading || backend.isError || vim.isError}
      onCheckedChange={change}
      divided
    />
  );
}

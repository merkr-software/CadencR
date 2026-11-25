import { translateUi } from "@/lib/i18n/ui";
import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetProjectSettingsQueryKey,
  type ProjectSetting,
  useGetProjectSettings,
  useSetProjectSetting,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { detectEditorLanguageId, type EditorLanguageId } from "@/lib/editor-language";
import {
  EDITOR_LANGUAGE_OVERRIDES_KEY,
  emptyEditorLanguageOverrides,
  getLanguageOverrideExtension,
  getLanguagePickerSelection,
  parseEditorLanguageOverrides,
  resolveEditorLanguageAssociation,
  resolveEditorLanguageId,
  updateEditorLanguageOverrides,
  type LanguagePickerSelection,
} from "@/lib/editor-language-overrides";

export interface EditorLanguageState {
  languageId: EditorLanguageId;
  detectedLanguageId: EditorLanguageId;
  inheritedLanguageId: EditorLanguageId;
  preference: LanguagePickerSelection["preference"];
  applyToExtension: boolean;
  extension: string | null;
  isLoading: boolean;
  isSaving: boolean;
  loadError: string | null;
  canSave: boolean;
  save: (selection: LanguagePickerSelection) => Promise<void>;
  retry: () => Promise<void>;
}

const projectSaveQueues = new Map<number, Promise<void>>();

export function useEditorLanguage(projectId: number, filePath: string): EditorLanguageState {
  const queryClient = useQueryClient();
  const settingsQuery = useGetProjectSettings(projectId, { query: { staleTime: Infinity } });
  const { data: settings, error: settingsError, isLoading, refetch } = settingsQuery;
  const { mutateAsync } = useSetProjectSetting();
  const [pendingSaveCount, setPendingSaveCount] = useState(0);
  const raw = useMemo(() => findSettingValue(settings, EDITOR_LANGUAGE_OVERRIDES_KEY), [settings]);

  const parsed = useMemo(() => {
    try {
      return { overrides: parseEditorLanguageOverrides(raw), error: null };
    } catch (error) {
      return {
        overrides: emptyEditorLanguageOverrides(),
        error: apiErrorMessage(
          error,
          translateUi(
            "workspace.editor.useEditorLanguage.readFailed",
            "Could not read language overrides",
          ),
        ),
      };
    }
  }, [raw]);

  const resolved = useMemo(
    () => ({
      languageId: resolveEditorLanguageId(filePath, parsed.overrides),
      detectedLanguageId: detectEditorLanguageId(filePath),
      inheritedLanguageId: resolveEditorLanguageAssociation(filePath, parsed.overrides),
      extension: getLanguageOverrideExtension(filePath),
      picker: getLanguagePickerSelection(filePath, parsed.overrides),
    }),
    [filePath, parsed.overrides],
  );
  const queryError = settingsError
    ? apiErrorMessage(
        settingsError,
        translateUi(
          "workspace.editor.useEditorLanguage.loadFailed",
          "Could not load language overrides",
        ),
      )
    : null;

  const save = useCallback(
    async (selection: LanguagePickerSelection): Promise<void> => {
      if (settingsError)
        throw new Error(
          translateUi(
            "workspace.editor.useEditorLanguage.overridesPending",
            "Language overrides have not loaded",
          ),
        );
      setPendingSaveCount((count) => count + 1);
      try {
        await enqueueProjectSave(projectId, async () => {
          const queryKey = getGetProjectSettingsQueryKey(projectId);
          const latestSettings = queryClient.getQueryData<ProjectSetting[]>(queryKey);
          const latestRaw = latestSettings
            ? findSettingValue(latestSettings, EDITOR_LANGUAGE_OVERRIDES_KEY)
            : raw;
          const current = parseEditorLanguageOverrides(latestRaw);
          const next = updateEditorLanguageOverrides(current, filePath, selection);
          const currentValue = JSON.stringify(current);
          const value = JSON.stringify(next);
          if (value === currentValue) return;

          await mutateAsync({
            id: projectId,
            data: { key: EDITOR_LANGUAGE_OVERRIDES_KEY, value },
          });
          queryClient.setQueryData<ProjectSetting[]>(queryKey, (existing) =>
            upsertSetting(existing ?? latestSettings ?? [], EDITOR_LANGUAGE_OVERRIDES_KEY, value),
          );
        });
      } finally {
        setPendingSaveCount((count) => Math.max(0, count - 1));
      }
    },
    [filePath, mutateAsync, projectId, queryClient, raw, settingsError],
  );

  const retry = useCallback(async (): Promise<void> => {
    await refetch();
  }, [refetch]);

  return useMemo(
    () => ({
      languageId: resolved.languageId,
      detectedLanguageId: resolved.detectedLanguageId,
      inheritedLanguageId: resolved.inheritedLanguageId,
      preference: resolved.picker.preference,
      applyToExtension: resolved.picker.applyToExtension,
      extension: resolved.extension,
      isLoading,
      isSaving: pendingSaveCount > 0,
      loadError: queryError ?? parsed.error,
      canSave: queryError === null && parsed.error === null,
      save,
      retry,
    }),
    [isLoading, parsed.error, pendingSaveCount, queryError, resolved, retry, save],
  );
}

function enqueueProjectSave(projectId: number, save: () => Promise<void>): Promise<void> {
  const previous = projectSaveQueues.get(projectId) ?? Promise.resolve();
  const queued = previous.catch(() => undefined).then(save);
  projectSaveQueues.set(projectId, queued);

  const clear = (): void => {
    if (projectSaveQueues.get(projectId) === queued) projectSaveQueues.delete(projectId);
  };
  void queued.then(clear, clear);
  return queued;
}

function findSettingValue(settings: ProjectSetting[] | undefined, key: string): string | null {
  return settings?.find((setting) => setting.key === key)?.value ?? null;
}

function upsertSetting(settings: ProjectSetting[], key: string, value: string): ProjectSetting[] {
  const found = settings.some((setting) => setting.key === key);
  return found
    ? settings.map((setting) => (setting.key === key ? { ...setting, value } : setting))
    : [...settings, { key, value }];
}

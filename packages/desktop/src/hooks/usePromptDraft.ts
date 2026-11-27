import { translateUi } from "@/lib/i18n/ui";
/**
 * Feature-scoped prompt draft persistence.
 *
 * Draft ownership is intentionally simple: one draft belongs to one feature.
 * The draft is stored in `feature_settings` under `draft_prompt`, so it can be
 * restored before any agent session row exists and cannot leak through
 * session-id transitions such as `/clear`.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getGetFeatureSettingsQueryKey,
  useGetFeatureSettings,
  useSetFeatureSetting,
  type FeatureSetting,
} from "@/api/generated";
import { settingsArrayToMap } from "@/api/settings";
import { apiErrorMessage } from "@/lib/api-errors";

const FEATURE_DRAFT_KEY = "draft_prompt";

interface UsePromptDraftOptions {
  featureId: number | undefined;
}

interface UsePromptDraftResult {
  initialDraft: string | null;
  draftFeatureId: number | null;
  saveDraft: (text: string | null) => void;
}

export function resetPromptDraftMemoryForTest(): void {}

function draftFromSettings(
  settings: Array<{ key: string; value: string }> | undefined,
): string | null {
  const value = settingsArrayToMap(settings)[FEATURE_DRAFT_KEY];
  return value ? value : null;
}

function upsertDraftSetting(
  settings: FeatureSetting[] | undefined,
  value: string,
): FeatureSetting[] {
  const current = settings ?? [];
  const index = current.findIndex((setting) => setting.key === FEATURE_DRAFT_KEY);
  if (index < 0) return [...current, { key: FEATURE_DRAFT_KEY, value }];
  if (current[index]?.value === value) return current;
  return current.map((setting, i) => (i === index ? { ...setting, value } : setting));
}

function reportDraftSaveError(error: unknown): void {
  toast.error(
    translateUi(
      "conversation.composer.usePromptDraft.saveFailed",
      "Could not save draft: {{error}}",
      {
        error: apiErrorMessage(
          error,
          translateUi("conversation.composer.usePromptDraft.unknownError", "Unknown error"),
        ),
      },
    ),
  );
}

export function usePromptDraft({ featureId }: UsePromptDraftOptions): UsePromptDraftResult {
  const queryClient = useQueryClient();
  const featureSettingsQuery = useGetFeatureSettings(featureId ?? 0, {
    query: { enabled: !!featureId },
  });
  const { mutate: saveFeatureSetting } = useSetFeatureSetting();

  const restoredFromSettings = useMemo(
    () => draftFromSettings(featureSettingsQuery.data),
    [featureSettingsQuery.data],
  );
  const pendingRef = useRef<{ value: string | null; seq: number } | undefined>(undefined);
  const requestSeqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushSave = useCallback(
    (targetFeatureId: number | undefined): void => {
      if (pendingRef.current === undefined) return;
      const draft = pendingRef.current.value;
      const requestSeq = pendingRef.current.seq;
      pendingRef.current = undefined;
      if (!targetFeatureId) return;
      saveFeatureSetting(
        {
          id: targetFeatureId,
          data: { key: FEATURE_DRAFT_KEY, value: draft ?? "" },
        },
        {
          onSuccess: (_data, variables): void => {
            if (requestSeqRef.current !== requestSeq) return;
            queryClient.setQueryData(
              getGetFeatureSettingsQueryKey(variables.id),
              (settings: FeatureSetting[] | undefined) =>
                upsertDraftSetting(settings, variables.data.value),
            );
          },
          onError: (error: unknown): void => {
            if (requestSeqRef.current !== requestSeq) return;
            reportDraftSaveError(error);
          },
        },
      );
    },
    [queryClient, saveFeatureSetting],
  );

  useEffect(() => {
    if (!featureSettingsQuery.isError) return;
    toast.error(
      translateUi(
        "conversation.composer.usePromptDraft.loadFailed",
        "Could not load draft: {{error}}",
        {
          error: apiErrorMessage(
            featureSettingsQuery.error,
            translateUi("conversation.composer.usePromptDraft.unknownError", "Unknown error"),
          ),
        },
      ),
    );
  }, [featureSettingsQuery.error, featureSettingsQuery.isError]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      flushSave(featureId);
    };
  }, [featureId, flushSave]);

  const saveDraft = useCallback(
    (text: string | null): void => {
      const requestSeq = requestSeqRef.current + 1;
      requestSeqRef.current = requestSeq;
      pendingRef.current = { value: text, seq: requestSeq };
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        flushSave(featureId);
      }, 500);
    },
    [featureId, flushSave],
  );

  return useMemo(
    () => ({
      initialDraft: restoredFromSettings,
      draftFeatureId: featureSettingsQuery.data ? (featureId ?? null) : null,
      saveDraft,
    }),
    [featureId, featureSettingsQuery.data, restoredFromSettings, saveDraft],
  );
}

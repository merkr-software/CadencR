import { translateUi } from "@/lib/i18n/ui";
import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  getListLayoutsQueryKey,
  useCreateLayout,
  useDeleteLayout,
  useListLayouts,
  useSetDefaultLayout,
  useUpdateLayout,
  type FeatureLayout,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { noteUserLayoutChange } from "@/lib/auto-layout/auto-layout-controller";
import {
  parseLayoutState,
  serializeLayoutForSave,
  type FeatureLayoutState,
} from "@/stores/feature-layout-schema";
import { selectFeatureLayout, useFeatureLayoutStore } from "@/stores/feature-layout-store";

function useLayoutMutationRunner() {
  const queryClient = useQueryClient();
  return useCallback(
    async <T>(
      action: () => Promise<T>,
      errorText: (message: string) => string,
      success?: (result: T) => string,
    ): Promise<T | null> => {
      try {
        const result = await action();
        void queryClient.invalidateQueries({ queryKey: getListLayoutsQueryKey() });
        if (success) toast.success(success(result));
        return result;
      } catch (error) {
        const message = apiErrorMessage(
          error,
          translateUi("workspace.tools.useSavedLayouts.unknownError", "Unknown error"),
        );
        toast.error(errorText(message));
        return null;
      }
    },
    [queryClient],
  );
}

function useNamedLayoutMutations(
  featureId: number,
  setAppliedLayoutId: (featureId: number, layoutId: number | null) => void,
) {
  const createMutation = useCreateLayout();
  const updateMutation = useUpdateLayout();
  const deleteMutation = useDeleteLayout();
  const setDefaultMutation = useSetDefaultLayout();
  const runMutation = useLayoutMutationRunner();
  const saveAsNew = useCallback(
    async (name: string): Promise<FeatureLayout | null> => {
      const current = selectFeatureLayout(featureId)(useFeatureLayoutStore.getState());
      const config = serializeLayoutForSave(current);
      const created = await runMutation(
        () => createMutation.mutateAsync({ data: { name, config } }),
        (message) =>
          translateUi(
            "workspace.tools.useSavedLayouts.saveFailed",
            "Could not save layout: {{message}}",
            { message },
          ),
        (layout) =>
          translateUi("workspace.tools.useSavedLayouts.saved", 'Layout "{{name}}" saved', {
            name: layout.name,
          }),
      );
      if (created) setAppliedLayoutId(featureId, created.id);
      return created;
    },
    [createMutation, featureId, runMutation, setAppliedLayoutId],
  );
  const updateExisting = useCallback(
    (id: number): Promise<FeatureLayout | null> => {
      const current = selectFeatureLayout(featureId)(useFeatureLayoutStore.getState());
      return runMutation(
        () =>
          updateMutation.mutateAsync({
            id,
            data: { config: serializeLayoutForSave(current) },
          }),
        (message) =>
          translateUi(
            "workspace.tools.useSavedLayouts.updateFailed",
            "Could not update layout: {{message}}",
            { message },
          ),
        (layout) =>
          translateUi("workspace.tools.useSavedLayouts.updated", 'Layout "{{name}}" updated', {
            name: layout.name,
          }),
      );
    },
    [featureId, runMutation, updateMutation],
  );
  const setDefault = useCallback(
    async (id: number): Promise<void> => {
      await runMutation(
        () => setDefaultMutation.mutateAsync({ id }),
        (message) =>
          translateUi(
            "workspace.tools.useSavedLayouts.setDefaultFailed",
            "Could not set default: {{message}}",
            { message },
          ),
        (layout) =>
          translateUi(
            "workspace.tools.useSavedLayouts.defaultUpdated",
            '"{{name}}" is now the default layout',
            { name: layout.name },
          ),
      );
    },
    [runMutation, setDefaultMutation],
  );
  const deleteLayout = useCallback(
    async (id: number): Promise<void> => {
      const result = await runMutation(
        () => deleteMutation.mutateAsync({ id }),
        (message) =>
          translateUi(
            "workspace.tools.useSavedLayouts.deleteFailed",
            "Could not delete layout: {{message}}",
            { message },
          ),
        () => translateUi("workspace.tools.useSavedLayouts.deleted", "Layout deleted"),
      );
      if (result === null) return;
      const applied = selectFeatureLayout(featureId)(
        useFeatureLayoutStore.getState(),
      ).appliedLayoutId;
      if (applied === id) setAppliedLayoutId(featureId, null);
    },
    [deleteMutation, featureId, runMutation, setAppliedLayoutId],
  );
  return useMemo(
    () => ({ saveAsNew, updateExisting, setDefault, deleteLayout }),
    [deleteLayout, saveAsNew, setDefault, updateExisting],
  );
}

/**
 * UX wrapper around the `feature_layouts` CRUD endpoints. Owns:
 *   - List of saved layouts + the current default.
 *   - Save current as new / update existing / select / set default / delete.
 *   - Applying a layout: hydrates the current per-feature layout state.
 *     Current layout state is persisted separately in `feature_settings`;
 *     explicit saves (Save as new / Update X) only manage named templates.
 */
export function useSavedLayouts(featureId: number) {
  const layoutsQuery = useListLayouts();
  const setStoreState = useFeatureLayoutStore((s) => s.setState);
  const setAppliedLayoutId = useFeatureLayoutStore((s) => s.setAppliedLayoutId);
  const layouts = useMemo(() => layoutsQuery.data ?? [], [layoutsQuery.data]);
  const defaultLayout = useMemo(() => layouts.find((l) => l.is_default) ?? null, [layouts]);
  const { saveAsNew, updateExisting, setDefault, deleteLayout } = useNamedLayoutMutations(
    featureId,
    setAppliedLayoutId,
  );

  /**
   * Apply a saved layout to the current feature: copy its config into the
   * in-memory store. Nothing is persisted per-feature — the store is the
   * single source of truth for the current session.
   */
  const apply = useCallback(
    (layout: FeatureLayout): void => {
      const parsed = parseLayoutState(layout.config);
      if (!parsed) {
        toast.error(
          translateUi(
            "workspace.tools.useSavedLayouts.malformed",
            'Layout "{{name}}" is malformed.',
            { name: layout.name },
          ),
        );
        return;
      }
      // A template carries no size memory; keep what auto layout learned here.
      const next: FeatureLayoutState = {
        ...parsed,
        appliedLayoutId: layout.id,
        autoShares: useFeatureLayoutStore.getState().features[featureId]?.autoShares,
      };
      noteUserLayoutChange(featureId, { structural: true });
      setStoreState(featureId, next);
    },
    [featureId, setStoreState],
  );

  return useMemo(
    () => ({
      layouts,
      defaultLayout,
      isLoading: layoutsQuery.isLoading,
      saveAsNew,
      updateExisting,
      setDefault,
      deleteLayout,
      apply,
    }),
    [
      layouts,
      defaultLayout,
      layoutsQuery.isLoading,
      saveAsNew,
      updateExisting,
      setDefault,
      deleteLayout,
      apply,
    ],
  );
}

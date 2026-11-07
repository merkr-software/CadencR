import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { EditorOpenFileParams } from "@cadencr/tab-sdk/protocol";
import { pluginTabsAvailable } from "@/lib/plugin-tabs/availability";
import { editorNavigation } from "@/lib/editors/editor-runtime";
import { readEditorTarget } from "@/lib/editors/editor-query";
import {
  rememberEditorFile,
  setEditorFallback,
  useEditorNavigationStore,
} from "@/lib/editors/editor-navigation-store";
import { useEditorStore } from "@/stores/editor-store";
import { activateFeatureTab } from "@/stores/feature-layout-store";
import { useIsMobile } from "./useIsMobile";
import { useDebouncedSetting } from "./useDebouncedSetting";
import { apiErrorMessage } from "@/lib/api-errors";
import { requestCodeMirrorFocus } from "@/lib/editors/code-mirror-focus";
import { EDITOR_BACKEND_KEY, resolveEditorId } from "@/lib/editors/editor-registry";
import { getGetWorkspaceSettingQueryKey, type SettingValueResponse } from "@/api/generated";
import { useFeatureLayoutContext } from "@/components/feature-layout/FeatureLayoutContext";

export type OpenEditorFile = (
  path: string,
  line?: number,
  column?: number,
  reveal?: () => void,
) => void;
interface NavigationOptions {
  paneId?: string;
  reveal?: () => void;
}

/** All user file navigation enters here; Preview keeps its separate action. */
export function useEditorFileNavigator() {
  const queryClient = useQueryClient();
  const mobile = useIsMobile();
  const { value: maxTabsValue } = useDebouncedSetting("editor_max_tabs");
  return useCallback(
    (featureId: number, params: EditorOpenFileParams, options: NavigationOptions = {}) => {
      const path = params.path;
      const pending = toast.loading(`Opening ${path}…`);
      const show = options.reveal ?? (() => activateFeatureTab(featureId, "editor"));
      const fallback = (file: EditorOpenFileParams): void => {
        const editor = useEditorStore.getState();
        editor.initFeature(featureId);
        const paneId =
          options.paneId ?? useEditorStore.getState().features[featureId]?.activePaneId ?? "main";
        const parsed = Number.parseInt(maxTabsValue ?? "10", 10);
        editor.openFile(
          featureId,
          paneId,
          file.path,
          Number.isFinite(parsed) ? parsed : 10,
          file.line,
          file.column,
        );
        requestCodeMirrorFocus(featureId);
      };
      const cachedBackend = queryClient.getQueryData<SettingValueResponse>(
        getGetWorkspaceSettingQueryKey(EDITOR_BACKEND_KEY),
      );
      const cachedVim = queryClient.getQueryData<SettingValueResponse>(
        getGetWorkspaceSettingQueryKey("editor_vim_mode_level"),
      );
      let targetId = resolveEditorId(cachedBackend?.value, cachedVim?.value ?? "0");
      void (async () => {
        try {
          await editorNavigation.open({
            featureId,
            target: async () => {
              const target = await readEditorTarget(
                queryClient,
                featureId,
                { desktop: pluginTabsAvailable(), mobile },
                (id) => {
                  targetId = id;
                },
              );
              targetId = target.id;
              const previous = useEditorNavigationStore.getState().fallbacks[featureId];
              return previous?.backendId === target.id
                ? { kind: "codemirror", id: target.id, reason: previous.reason }
                : target;
            },
            params,
            reveal: show,
            fallback,
            isCurrent: () => {
              const backend = queryClient.getQueryData<SettingValueResponse>(
                getGetWorkspaceSettingQueryKey(EDITOR_BACKEND_KEY),
              );
              const vim = queryClient.getQueryData<SettingValueResponse>(
                getGetWorkspaceSettingQueryKey("editor_vim_mode_level"),
              );
              return !backend || resolveEditorId(backend.value, vim?.value ?? "0") === targetId;
            },
            opened: (file) => rememberEditorFile(featureId, targetId, file),
            failed: (reason) => setEditorFallback(featureId, targetId, reason),
          });
        } catch (error: unknown) {
          toast.error(apiErrorMessage(error, "The file could not be opened"));
        } finally {
          toast.dismiss(pending);
        }
      })();
    },
    [maxTabsValue, mobile, queryClient],
  );
}

export function useOpenEditorFile(
  featureId: number,
  { paneId }: { paneId?: string } = {},
): OpenEditorFile {
  const navigate = useEditorFileNavigator();
  const layoutFeatureId = useFeatureLayoutContext()?.featureId ?? featureId;
  return useCallback(
    (path, line, column, reveal) =>
      navigate(
        featureId,
        { path, line, column },
        {
          paneId,
          reveal: reveal ?? (() => activateFeatureTab(layoutFeatureId, "editor")),
        },
      ),
    [featureId, layoutFeatureId, navigate, paneId],
  );
}

import { useCallback, useEffect, useMemo, useRef } from "react";
import type { EditorView } from "@codemirror/view";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api-errors";
import { editorNavigation } from "@/lib/editors/editor-runtime";
import { registerCodeMirrorFocus } from "@/lib/editors/code-mirror-focus";
import type { EditorTarget } from "@/lib/editors/editor-registry";

export function useEditorFocusState(
  featureId: number,
  activePaneId: string,
  isEditorFocused: boolean,
  target: EditorTarget,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const editorViewsRef = useRef<Map<string, EditorView>>(new Map());
  const mounted = useRef(false);
  const latest = useRef({ target, isEditorFocused });
  latest.current = { target, isEditorFocused };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const focusActiveEditor = useCallback((): void => {
    if (editorNavigation.isOpening(featureId) && target.kind !== "codemirror") return;
    const editor = editorViewsRef.current.get(activePaneId);
    if (editor && target.kind === "codemirror") editor.focus();
    else
      void editorNavigation
        .focus(
          featureId,
          target,
          () =>
            mounted.current &&
            latest.current.isEditorFocused &&
            latest.current.target.id === target.id &&
            latest.current.target.kind === target.kind,
        )
        .catch((error: unknown) =>
          toast.error(apiErrorMessage(error, "The editor could not be focused")),
        );
  }, [activePaneId, featureId, target]);
  useEffect(
    () =>
      registerCodeMirrorFocus(featureId, () => editorViewsRef.current.get(activePaneId)?.focus()),
    [activePaneId, featureId],
  );
  const shouldRestoreEditorFocus = useCallback((): boolean => {
    const active = document.activeElement;
    return !(active instanceof HTMLElement && rootRef.current?.contains(active));
  }, []);
  const handleEditorViewChange = useCallback(
    (paneId: string, view: EditorView | null): void => {
      if (!view) {
        editorViewsRef.current.delete(paneId);
        return;
      }
      editorViewsRef.current.set(paneId, view);
      if (isEditorFocused && paneId === activePaneId && shouldRestoreEditorFocus()) {
        requestAnimationFrame(() => view.focus());
      }
    },
    [activePaneId, isEditorFocused, shouldRestoreEditorFocus],
  );
  const getActiveView = useCallback(
    () => editorViewsRef.current.get(activePaneId) ?? null,
    [activePaneId],
  );
  return useMemo(
    () => ({
      focusActiveEditor,
      getActiveView,
      handleEditorViewChange,
      rootRef,
      shouldRestoreEditorFocus,
    }),
    [focusActiveEditor, getActiveView, handleEditorViewChange, shouldRestoreEditorFocus],
  );
}

import { EditorOperationError } from "./editor-error-message";
import { useCallback, useMemo, useRef, type RefObject } from "react";
import type { EditorView } from "@codemirror/view";
import { useQueryClient } from "@tanstack/react-query";
import { getReadFileQueryKey, readFile, useWriteFile } from "@/api/generated";
import type { useFreshFileContentSync } from "./useFreshFileContentSync";
import { readFileResponseFromContent } from "./editor-file-cache";

interface EditorWriteOptions {
  projectId: number;
  featureId: number;
  filePath: string;
  viewRef: RefObject<EditorView | null>;
  beforeWrite?: () => Promise<void>;
  sync: ReturnType<typeof useFreshFileContentSync>;
}

export function useEditorWrite({
  projectId,
  featureId,
  filePath,
  viewRef,
  beforeWrite,
  sync,
}: EditorWriteOptions) {
  const queryClient = useQueryClient();
  const mutation = useWriteFile();
  const latest = useRef({ beforeWrite, mutate: mutation.mutateAsync, sync });
  latest.current = { beforeWrite, mutate: mutation.mutateAsync, sync };
  // Serialize saves and reloads: an older write must never finish after a newer one.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback(<T>(operation: () => Promise<T>): Promise<T> => {
    const task = queue.current.then(operation);
    // Callers surface failures; a rejected operation must not poison the queue.
    queue.current = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }, []);
  const params = useMemo(
    () => ({ project_id: projectId, feature_id: featureId, file_path: filePath }),
    [projectId, featureId, filePath],
  );
  const queryKey = useMemo(() => getReadFileQueryKey(params), [params]);

  const write = useCallback(
    async (quiet: boolean, overwrite = false): Promise<string | null> => {
      const view = viewRef.current;
      return enqueue(async () => {
        if (!view || viewRef.current !== view) return null;
        const canWrite = () => {
          if (!latest.current.sync.conflictRef.current || overwrite) return true;
          if (quiet) return false;
          throw new EditorOperationError(
            "File changed on disk. Use the orange disk indicator to reload or explicitly overwrite it.",
            (t) =>
              t(
                "workspace.editor.useEditorWrite.diskChanged",
                "File changed on disk. Use the orange disk indicator to reload or explicitly overwrite it.",
              ),
          );
        };
        if (!canWrite()) return null;
        if (quiet && !latest.current.sync.dirtyRef.current) return null;
        // Autosave must not introduce whitespace edits while the user is typing.
        if (!quiet) await latest.current.beforeWrite?.();
        if (viewRef.current !== view) return null;
        if (!canWrite()) return null;
        const doc = view.state.doc;
        const content = doc.toString();
        await queryClient.cancelQueries({ queryKey, exact: true });
        await latest.current.mutate({ data: { ...params, content } });
        // Discard reads begun before/during our write, then verify disk again.
        await queryClient.cancelQueries({ queryKey, exact: true });
        if (viewRef.current === view) latest.current.sync.markSaved(doc);
        const lineCount = doc.lines - Number(doc.line(doc.lines).length === 0);
        queryClient.setQueryData(queryKey, readFileResponseFromContent(content, lineCount));
        void queryClient.invalidateQueries({ queryKey, exact: true });
        return content;
      });
    },
    [enqueue, params, queryClient, queryKey, viewRef],
  );

  const reload = useCallback(async () => {
    const view = viewRef.current;
    const doc = view?.state.doc;
    return enqueue(async () => {
      if (!view || viewRef.current !== view) return;
      await queryClient.cancelQueries({ queryKey, exact: true });
      const result = await readFile(params);
      await queryClient.cancelQueries({ queryKey, exact: true });
      if (viewRef.current !== view || view.state.doc !== doc) {
        throw new EditorOperationError(
          "The buffer changed while reloading. Your edits were kept; reload again when ready.",
          (t) =>
            t(
              "workspace.editor.useEditorWrite.bufferChanged",
              "The buffer changed while reloading. Your edits were kept; reload again when ready.",
            ),
        );
      }
      latest.current.sync.reload(result.content);
      queryClient.setQueryData(queryKey, result);
    });
  }, [enqueue, params, queryClient, queryKey, viewRef]);

  return useMemo(() => ({ write, reload }), [write, reload]);
}

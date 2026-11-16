import { useCallback, useMemo } from "react";
import {
  useDeleteSessionQueuedPrompt,
  useEnqueueSessionPrompt,
  useListSessionPromptQueue,
  useSendSessionQueuedPromptNow,
  useUpdateSessionQueuedPrompt,
  type QueuedPrompt,
} from "@/api/generated";
import { toastError } from "@/lib/api-errors";
import { invalidatePromptQueue } from "@/lib/prompt-queue";

const EMPTY: QueuedPrompt[] = [];

export interface PromptQueueApi {
  /** False when the conversation has no DB session yet (nothing to queue on). */
  available: boolean;
  items: QueuedPrompt[];
  /** Resolves on success; rejects (after a toast) so the send runner keeps the text. */
  enqueue: (content: string) => Promise<void>;
  /** The rest resolve to whether the server accepted the change (a refusal is toasted). */
  update: (id: number, content: string) => Promise<boolean>;
  remove: (id: number) => Promise<boolean>;
  sendNow: (id: number) => Promise<boolean>;
  /** A queue request is in flight. */
  busy: boolean;
}

/**
 * A session's prompts queued for after the current turn. The list is the
 * server's: every change is confirmed by the backend (and re-broadcast as
 * `prompt_queue_changed`) before it shows, never applied optimistically.
 */
export function usePromptQueue(sessionId: number | undefined): PromptQueueApi {
  const available = sessionId != null;
  const id = sessionId ?? 0;
  const list = useListSessionPromptQueue(id, { query: { enabled: available } });
  // `mutateAsync` is stable across renders; the mutation objects are not, and
  // depending on them would rebuild every callback (and the editor's key
  // commands downstream) on each streamed delta.
  const { mutateAsync: enqueueAsync, isPending: enqueuing } = useEnqueueSessionPrompt();
  const { mutateAsync: updateAsync, isPending: updating } = useUpdateSessionQueuedPrompt();
  const { mutateAsync: deleteAsync, isPending: deleting } = useDeleteSessionQueuedPrompt();
  const { mutateAsync: sendNowAsync, isPending: sendingNow } = useSendSessionQueuedPromptNow();

  // A confirmed change is re-broadcast as `prompt_queue_changed`, which
  // refetches the list; only a refusal needs a refetch here, since the queue
  // may have moved under us (e.g. the item was already delivered).
  const run = useCallback(
    async (action: () => Promise<unknown>, failure: string): Promise<boolean> => {
      try {
        await action();
        return true;
      } catch (error) {
        toastError(error, failure);
        invalidatePromptQueue(id);
        return false;
      }
    },
    [id],
  );

  const enqueue = useCallback(
    async (content: string) => {
      const queued = await run(
        () => enqueueAsync({ sessionId: id, data: { content } }),
        "Couldn't queue the message",
      );
      if (!queued) throw new Error("The message was not queued");
    },
    [enqueueAsync, id, run],
  );
  const update = useCallback(
    (promptId: number, content: string) =>
      run(
        () => updateAsync({ sessionId: id, id: promptId, data: { content } }),
        "Couldn't update the queued message",
      ),
    [id, run, updateAsync],
  );
  const remove = useCallback(
    (promptId: number) =>
      run(() => deleteAsync({ sessionId: id, id: promptId }), "Couldn't remove the queued message"),
    [deleteAsync, id, run],
  );
  const sendNow = useCallback(
    (promptId: number) =>
      run(() => sendNowAsync({ sessionId: id, id: promptId }), "Couldn't send the queued message"),
    [id, run, sendNowAsync],
  );

  const busy = enqueuing || updating || deleting || sendingNow;

  return useMemo(
    () => ({
      available,
      items: list.data ?? EMPTY,
      enqueue,
      update,
      remove,
      sendNow,
      busy,
    }),
    [available, busy, enqueue, list.data, remove, sendNow, update],
  );
}

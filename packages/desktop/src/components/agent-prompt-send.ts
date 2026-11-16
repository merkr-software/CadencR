/**
 * `AgentPromptBar` send-runner hook.
 *
 * The bar's submit handler has to await an async `onSend` (so a failed
 * pre-send step like saving worktree settings doesn't drop the user's
 * text), surface a busy state while the call is in-flight, and restore
 * the draft on rejection. Extracted into its own hook so the prompt-bar
 * file stays under the 400-line cap.
 *
 * Caller contract:
 *   - `editorRef` is the imperative handle to the prompt editor (clear,
 *     setText, focus).
 *   - `setText` is the React state setter that mirrors the editor's text.
 *   - `clearAttachments` empties the image picker.
 *   - `saveDraft(null)` is called on success to drop the persisted draft;
 *     until then `sendInFlightRef` keeps the send-time clear from wiping it.
 *   - `history.addEntry(trimmed)` records the submitted prompt (no-op when
 *     `projectId` is missing).
 *   - The async call site must surface its own toast — this hook only
 *     handles the local UX (clearing/restoring text, busy flag).
 */
import { useCallback, useMemo, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { ImageAttachment } from "@/hooks/useImageAttachments";
import type { PromptAttachmentPayload } from "@/types/agent-types";
import type { PromptEditorHandle } from "./prompt-editor/PromptEditor";

export type SendFn = (
  text: string,
  attachments?: PromptAttachmentPayload[],
) => void | Promise<void>;

export interface RunSendDeps {
  editorRef: RefObject<PromptEditorHandle | null>;
  setText: (text: string) => void;
  clearAttachments: (options?: { revokeObjectUrls?: boolean }) => void;
  restoreAttachments: (attachments: ImageAttachment[]) => void;
  saveDraft: (text: string | null) => void;
  addHistoryEntry: (text: string) => void;
  getAttachments: () => ImageAttachment[];
  /** Flipped true on send so a late draft refetch can't re-inject sent text. */
  interactedRef: MutableRefObject<boolean>;
  /** True while `send` is pending; editor changes then skip draft persistence. */
  sendInFlightRef: MutableRefObject<boolean>;
}

export interface AgentPromptSendApi {
  /** True while a submit is awaiting `send`. Drives the spinner + disabled. */
  sending: boolean;
  /**
   * Run the supplied send function with the trimmed text + current images.
   * Clears the input immediately for snappy feedback; on rejection the
   * draft is restored so the user can retry without retyping.
   */
  runSend: (send: SendFn, trimmed: string) => Promise<void>;
}

export function useAgentPromptSend(deps: RunSendDeps): AgentPromptSendApi {
  const {
    editorRef,
    setText,
    clearAttachments,
    restoreAttachments,
    saveDraft,
    addHistoryEntry,
    getAttachments,
    interactedRef,
    sendInFlightRef,
  } = deps;
  const [sending, setSending] = useState(false);
  // On phones, dismiss the on-screen keyboard when sending and keep it closed.
  const isMobile = useIsMobile();

  const runSend = useCallback(
    async (send: SendFn, trimmed: string): Promise<void> => {
      // Sending hands the input to the user, suppressing later draft restore.
      interactedRef.current = true;
      const attachments = getAttachments();
      const payloadAttachments =
        attachments.length > 0
          ? attachments.map((a) => ({
              base64: a.base64,
              fileName: a.fileName,
              kind: a.kind,
              mimeType: a.mimeType,
            }))
          : undefined;
      // Optimistically clear the visible textarea so the user sees their
      // submission "in flight". On failure we restore it below.
      sendInFlightRef.current = true;
      setText("");
      editorRef.current?.clear();
      if (isMobile) editorRef.current?.blur();
      clearAttachments({ revokeObjectUrls: false });
      setSending(true);
      try {
        await send(trimmed, payloadAttachments);
        // Success: drop the persisted draft, record history, refocus.
        attachments.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
        addHistoryEntry(trimmed);
        saveDraft(null);
        if (!isMobile) requestAnimationFrame(() => editorRef.current?.focus());
      } catch {
        // Restore the prompt so the user can retry without retyping.
        // The async call site is responsible for the toast (per the
        // PushDialog pattern).
        setText(trimmed);
        editorRef.current?.setText(trimmed, !isMobile);
        restoreAttachments(attachments);
        if (!isMobile) requestAnimationFrame(() => editorRef.current?.focus());
      } finally {
        sendInFlightRef.current = false;
        setSending(false);
      }
    },
    [
      editorRef,
      setText,
      clearAttachments,
      restoreAttachments,
      saveDraft,
      addHistoryEntry,
      getAttachments,
      interactedRef,
      sendInFlightRef,
      isMobile,
    ],
  );

  return useMemo(() => ({ sending, runSend }), [sending, runSend]);
}

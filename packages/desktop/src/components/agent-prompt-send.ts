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
 *   - `saveDraft(null)` is called on success to drop the persisted draft.
 *   - `history.addEntry(trimmed)` records the submitted prompt (no-op when
 *     `projectId` is missing).
 *   - The async call site must surface its own toast — this hook only
 *     handles the local UX (clearing/restoring text, busy flag).
 */
import { useCallback, useMemo, useState } from "react";
import type { RefObject } from "react";
import {
  formatTextAttachmentsForPrompt,
  isImageAttachment,
  isTextAttachment,
  type PromptAttachment,
} from "@/lib/prompt-attachments";
import type { PromptEditorHandle } from "./prompt-editor/PromptEditor";

export type SendFn = (
  text: string,
  images?: Array<{ base64: string; mimeType: string }>,
) => void | Promise<void>;

export interface RunSendDeps {
  editorRef: RefObject<PromptEditorHandle | null>;
  setText: (text: string) => void;
  clearAttachments: (options?: { revokeObjectUrls?: boolean }) => void;
  restoreAttachments: (attachments: PromptAttachment[]) => void;
  saveDraft: (text: string | null) => void;
  addHistoryEntry: (text: string) => void;
  getAttachments: () => PromptAttachment[];
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
  } = deps;
  const [sending, setSending] = useState(false);

  const runSend = useCallback(
    async (send: SendFn, trimmed: string): Promise<void> => {
      const attachments = getAttachments();
      // Images travel as base64 blocks; text files are inlined into the
      // prompt text so every provider sees them as plain text.
      const imageAttachments = attachments.filter(isImageAttachment);
      const textAttachments = attachments.filter(isTextAttachment);
      const images =
        imageAttachments.length > 0
          ? imageAttachments.map((a) => ({ base64: a.base64, mimeType: a.mimeType }))
          : undefined;
      const sendText = formatTextAttachmentsForPrompt(trimmed, textAttachments);
      // Optimistically clear the visible textarea so the user sees their
      // submission "in flight". On failure we restore it below.
      setText("");
      editorRef.current?.clear();
      clearAttachments({ revokeObjectUrls: false });
      setSending(true);
      try {
        await send(sendText, images);
        // Success: drop the persisted draft, record history, refocus.
        imageAttachments.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
        addHistoryEntry(trimmed);
        saveDraft(null);
        requestAnimationFrame(() => editorRef.current?.focus());
      } catch {
        // Restore the prompt so the user can retry without retyping.
        // The async call site is responsible for the toast (per the
        // PushDialog pattern).
        setText(trimmed);
        editorRef.current?.setText(trimmed);
        restoreAttachments(attachments);
        requestAnimationFrame(() => editorRef.current?.focus());
      } finally {
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
    ],
  );

  return useMemo(() => ({ sending, runSend }), [sending, runSend]);
}

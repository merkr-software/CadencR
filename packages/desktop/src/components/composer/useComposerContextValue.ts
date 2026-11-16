import { useCallback, useMemo } from "react";
import type { AgentPromptBarProps } from "../agent-prompt-bar-types";
import { setComposerDraft } from "../agent-prompt-draft-restore";
import type { AgentPromptBarController } from "../useAgentPromptBarController";
import type { ComposerContextValue, ComposerEditorApi } from "./ComposerContext";

/** Memoized `ComposerContext` value built from the prompt bar's controller. */
export function useComposerContextValue(
  props: AgentPromptBarProps,
  controller: AgentPromptBarController,
): ComposerContextValue {
  const { state } = controller;
  const { editorRef, restoringDraftRef, setText, interactedRef } = state;
  const { saveDraft } = state.draft;
  const editor = useMemo<ComposerEditorApi>(
    () => ({
      focus: () => editorRef.current?.focus(),
      getText: () => editorRef.current?.getText() ?? "",
      setText: (text) =>
        setComposerDraft({ restoringDraftRef, setText, editorRef, interactedRef, saveDraft }, text),
      insertText: (text) => editorRef.current?.insertText(text),
    }),
    [editorRef, interactedRef, restoringDraftRef, saveDraft, setText],
  );
  const { attachments, addFiles, removeAttachment } = state.attachments;
  const onSend = props.onSend;
  const send = useCallback(
    (text: string) =>
      void Promise.resolve(onSend(text)).catch(() => {
        // The send handler already toasted the failure.
      }),
    [onSend],
  );
  const attachmentsApi = useMemo(
    () => ({ items: attachments, add: addFiles, remove: removeAttachment }),
    [attachments, addFiles, removeAttachment],
  );
  return useMemo(
    () => ({
      featureId: props.featureId,
      projectId: props.projectId,
      sessionId: props.sessionId,
      wsSessionId: props.wsSessionId,
      isRunning: controller.isRunning,
      isFirstPrompt: props.isFirstPrompt ?? false,
      editor,
      attachments: attachmentsApi,
      contextUsage: props.contextUsage ?? null,
      history: state.history.entries,
      sessionInfo: props.sessionInfo,
      slashCommands: props.slashCommandsOverride,
      send,
      startOnBranch: props.referencedWorktreeSelection?.onSelect,
    }),
    [
      attachmentsApi,
      controller.isRunning,
      editor,
      props.contextUsage,
      state.history.entries,
      props.sessionInfo,
      props.featureId,
      props.isFirstPrompt,
      props.slashCommandsOverride,
      props.referencedWorktreeSelection?.onSelect,
      send,
      props.projectId,
      props.sessionId,
      props.wsSessionId,
    ],
  );
}

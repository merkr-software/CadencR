import {
  useState,
  useCallback,
  useEffect,
  useRef,
  useImperativeHandle,
  forwardRef,
  useMemo,
} from "react";
import { promptDropTargetIdOf } from "@/lib/prompt-drop-target";
import { useScopedShortcut } from "@/hooks/useShortcut";
import { useShortcut } from "@/hooks/useShortcut";
import { Loader2, Send, Pause } from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentQuestionDrawer } from "./AgentQuestionDrawer";
import { PlanApprovalBar } from "./PlanApprovalBar";
import { ToolPermissionPrompt } from "./ToolPermissionPrompt";
import { AgentPromptPendingIndicator } from "./AgentPromptPendingIndicator";
import { ImageAttachmentPreview } from "./ImageAttachmentPreview";
import { ImageAttachmentButton } from "./ImageAttachmentButton";
import { SplitSendActions } from "./SplitSendActions";
import { PromptEditor } from "./prompt-editor/PromptEditor";
import type { PromptEditorHandle } from "./prompt-editor/PromptEditor";
import { shouldFocusPromptFromSurfaceClick } from "./agent-prompt-focus";
import { useImageAttachments } from "@/hooks/useImageAttachments";
import { usePromptDraft } from "@/hooks/usePromptDraft";
import { draftScope } from "@/lib/draft-scope";
import { usePromptEditorRestore } from "@/hooks/usePromptEditorRestore";
import { usePromptHistory } from "@/hooks/usePromptHistory";
import { useListFiles } from "@/api/generated";
import { useAgentPromptSend } from "./agent-prompt-send";
import { useDeferredAgentPrompts } from "./useDeferredAgentPrompts";
import type {
  AgentPromptBarHandle,
  AgentPromptBarProps,
  SplitSendAction,
} from "./agent-prompt-bar-types";
export type { AgentPromptBarHandle, SplitSendAction } from "./agent-prompt-bar-types";
export const AgentPromptBar = forwardRef<AgentPromptBarHandle, AgentPromptBarProps>(
  function AgentPromptBar(
    {
      onSend,
      onStop,
      status,
      splitSendActions,
      disabled,
      pendingQuestions,
      onQuestionResponse,
      disableShortcuts,
      onCollapse,
      onPermissionModeToggle,
      pendingPlanApproval,
      planApproveLabel,
      planApprovalError,
      onPlanApprove,
      onPlanRequestChanges,
      onPlanReject,
      onGateClose,
      onOpenModelPicker,
      agentTabActive = true,
      featureId,
      projectId,
      sessionId,
      wsSessionId,
      initialDraft,
      onToggleMaximize,
      noTopPadding,
      slashCommandsOverride,
      slashCommandsLoading,
      pendingPermission,
      onPermissionDecision,
      isSubmittingPermission,
    },
    ref,
  ) {
    const editorRef = useRef<PromptEditorHandle>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const [text, setText] = useState(initialDraft ?? "");
    const textRef = useRef(text);
    textRef.current = text;
    const disabledRef = useRef(disabled);
    disabledRef.current = disabled;
    const navigatingHistoryRef = useRef(false);
    const hadSpecialStateRef = useRef(false);
    const shouldRestoreFocusRef = useRef(false);
    const draft = usePromptDraft({ sessionId, wsSessionId, initialDraft: initialDraft ?? null });
    const { initialDraft: restoredDraft, saveDraft } = draft;
    usePromptEditorRestore({
      restoredDraft,
      dbSessionId: draft.dbSessionId,
      conversationKey: draftScope(sessionId, wsSessionId),
      textRef,
      editorRef,
      setText,
    });
    const {
      visiblePermission,
      visiblePlanApproval,
      visibleQuestions,
      permissionDeferred,
      planApprovalDeferred,
      questionsDeferred,
    } = useDeferredAgentPrompts({
      pendingPermission,
      pendingPlanApproval,
      pendingQuestions,
      promptText: text,
    });
    const hasSpecialState =
      !!visiblePermission ||
      !!visiblePlanApproval ||
      (!!visibleQuestions && visibleQuestions.length > 0);
    useEffect(() => {
      if (hasSpecialState) {
        hadSpecialStateRef.current = true;
        shouldRestoreFocusRef.current = !!wrapperRef.current?.contains(document.activeElement);
        return;
      }
      if (!hadSpecialStateRef.current) return;
      hadSpecialStateRef.current = false;
      if (!shouldRestoreFocusRef.current) return;
      shouldRestoreFocusRef.current = false;
      requestAnimationFrame(() => editorRef.current?.focus());
    }, [hasSpecialState]);
    const history = usePromptHistory(projectId ?? 0, wsSessionId);
    // Must match the id stamped on the enclosing agent `<section>` in
    // `WebSocketSessionFeatureBlock` — the section is the actual drop zone,
    // and this hook only accepts drops whose `targetPromptId` matches.
    const promptDropTargetId = useMemo(
      () => promptDropTargetIdOf({ wsSessionId, dbSessionId: sessionId, featureId }),
      [wsSessionId, sessionId, featureId],
    );
    const {
      attachments,
      addFiles,
      removeAttachment,
      clearAttachments,
      restoreAttachments,
      dragHandlers,
    } = useImageAttachments(promptDropTargetId);
    const filesQuery = useListFiles(
      { feature_id: featureId! },
      { query: { enabled: !!featureId && agentTabActive && !disabled } },
    );
    useImperativeHandle(ref, () => ({
      focusInput: () => editorRef.current?.focus(),
    }));
    const isRunning = status === "agent";
    const isPaused = status === "question";
    const getAttachments = useCallback(() => attachments, [attachments]);
    const addHistoryEntry = useCallback(
      (entry: string) => {
        if (projectId) history.addEntry(entry);
      },
      [projectId, history],
    );
    const { sending, runSend } = useAgentPromptSend({
      editorRef,
      setText,
      clearAttachments,
      restoreAttachments,
      saveDraft,
      addHistoryEntry,
      getAttachments,
    });
    const canSend =
      (text.trim().length > 0 || attachments.length > 0) &&
      !disabled &&
      !sending &&
      !permissionDeferred;
    const handleSend = useCallback(() => {
      if (permissionDeferred) return;
      const trimmed = textRef.current.trim();
      if (!trimmed && attachments.length === 0) return;
      void runSend(onSend, trimmed);
    }, [attachments, onSend, permissionDeferred, runSend]);
    const handleSplitAction = useCallback(
      (action: SplitSendAction) => {
        if (permissionDeferred) return;
        const trimmed = textRef.current.trim();
        if (!trimmed && attachments.length === 0) return;
        void runSend(action.onClick, trimmed);
      },
      [attachments, permissionDeferred, runSend],
    );
    const handleEnterSend = useCallback(() => {
      if (permissionDeferred) return true;
      const trimmed = textRef.current.trim();
      const hasContent = trimmed.length > 0 || attachments.length > 0;
      if (!hasContent || disabledRef.current || sending) return true;
      if (splitSendActions && splitSendActions.length > 0) {
        handleSplitAction(splitSendActions[0]);
      } else {
        handleSend();
      }
      return true;
    }, [attachments, sending, splitSendActions, permissionDeferred, handleSplitAction, handleSend]);
    const handleEditorChange = useCallback(
      (newText: string) => {
        setText(newText);
        if (navigatingHistoryRef.current) {
          navigatingHistoryRef.current = false;
          return;
        }
        saveDraft(newText);
        history.resetNavigation();
      },
      [saveDraft, history],
    );
    const handleArrowUp = useCallback(() => {
      if (!projectId || !wsSessionId) return null;
      const result = history.navigateUp(textRef.current);
      if (result !== null) navigatingHistoryRef.current = true;
      return result;
    }, [projectId, wsSessionId, history]);

    const handleArrowDown = useCallback(() => {
      if (!projectId || !wsSessionId || history.historyIndex < 0) return null;
      const result = history.navigateDown();
      if (result !== null) navigatingHistoryRef.current = true;
      return result;
    }, [projectId, wsSessionId, history]);

    const handlePromptSurfaceClick = useCallback(
      (event: React.MouseEvent<HTMLDivElement>): void => {
        if (!shouldFocusPromptFromSurfaceClick(event.target)) return;
        editorRef.current?.focus();
      },
      [],
    );

    const hotkeyOpts = { enabled: agentTabActive };
    useScopedShortcut(
      "agent-model-picker",
      (e) => {
        if (!onOpenModelPicker) return;
        e.preventDefault();
        onOpenModelPicker();
      },
      "agent",
      hotkeyOpts,
    );

    useScopedShortcut(
      "agent-maximize",
      (e) => {
        if (!onToggleMaximize) return;
        e.preventDefault();
        onToggleMaximize();
      },
      "agent",
      hotkeyOpts,
    );

    useScopedShortcut(
      "agent-permission-mode",
      (e) => {
        if (!onPermissionModeToggle) return;
        e.preventDefault();
        onPermissionModeToggle();
      },
      "agent",
      hotkeyOpts,
    );

    useScopedShortcut(
      "agent-collapse",
      (e) => {
        if (isRunning || !onCollapse) return;
        e.preventDefault();
        onCollapse();
      },
      "agent",
      hotkeyOpts,
    );

    // `agent-stop` (Esc) is bound globally and gated in-callback so it fires
    // even while focus is inside another tab — we only swallow it when the
    // user is actually pointed at this prompt bar with a turn in flight.
    useShortcut(
      "agent-stop",
      (e) => {
        if (!isRunning) return;
        if (!wrapperRef.current?.contains(document.activeElement)) return;
        e.preventDefault();
        onStop();
      },
      { enableOnFormTags: true, enableOnContentEditable: true },
      [isRunning, onStop],
    );

    const specialPrompt =
      visiblePermission && onPermissionDecision ? (
        <ToolPermissionPrompt
          key={
            visiblePermission.requestId ??
            `${visiblePermission.toolName}:${visiblePermission.pattern}`
          }
          permission={visiblePermission}
          onDecision={onPermissionDecision}
          onCancel={onGateClose}
          disableShortcuts={disableShortcuts}
          isSubmitting={!!isSubmittingPermission}
        />
      ) : visiblePlanApproval && onPlanApprove && onPlanRequestChanges ? (
        <PlanApprovalBar
          allowedPrompts={visiblePlanApproval.allowedPrompts}
          // Mirror the prompt-bar text so the rejection box behaves predictably.
          initialFeedback={text}
          approveLabel={planApproveLabel}
          onApprove={onPlanApprove}
          onRequestChanges={onPlanRequestChanges}
          onReject={onGateClose ?? onPlanReject}
          error={planApprovalError}
        />
      ) : !!visibleQuestions && visibleQuestions.length > 0 && onQuestionResponse ? (
        <AgentQuestionDrawer
          questions={visibleQuestions}
          open={true}
          onSubmit={onQuestionResponse}
          onCancel={onGateClose}
          inline
          disableShortcuts={disableShortcuts}
        />
      ) : null;

    return (
      <>
        {permissionDeferred && pendingPermission && (
          <AgentPromptPendingIndicator kind="permission" detail={pendingPermission.toolName} />
        )}
        {planApprovalDeferred && <AgentPromptPendingIndicator kind="plan" />}
        {questionsDeferred && <AgentPromptPendingIndicator kind="question" />}
        {specialPrompt && (
          <div data-permission-area={!!visiblePermission} data-question-area>
            {specialPrompt}
          </div>
        )}
        <div
          ref={wrapperRef}
          data-agent-prompt-bar="true"
          hidden={hasSpecialState}
          aria-hidden={hasSpecialState}
          className={cn(
            "flex flex-col px-3 pb-4",
            noTopPadding ? "pt-0" : "pt-3",
            // The drop zone is the agent `<section>` above; it toggles
            // `data-agent-dragover` while a file is dragged over this card,
            // and that drives the primary ring here without needing React
            // state to cross component boundaries.
            "group-data-[agent-dragover]/agent-section:ring-2 group-data-[agent-dragover]/agent-section:ring-inset group-data-[agent-dragover]/agent-section:ring-primary/50",
          )}
          {...dragHandlers}
        >
          {attachments.length > 0 && (
            <ImageAttachmentPreview
              attachments={attachments}
              onRemove={removeAttachment}
              className="mb-2"
            />
          )}

          <div
            className="flex items-center gap-1.5 rounded-lg bg-muted/40 py-4 pl-4 pr-2.5 transition-colors focus-within:bg-muted/55"
            onClick={handlePromptSurfaceClick}
          >
            <PromptEditor
              ref={editorRef}
              onChange={handleEditorChange}
              onEnterSend={handleEnterSend}
              onArrowUp={handleArrowUp}
              onArrowDown={handleArrowDown}
              disabled={disabled || sending}
              placeholder={
                isPaused
                  ? "Send a message to resume…"
                  : "Send a message… (@ files, / commands, $ skills)"
              }
              className="max-h-[40vh] min-h-0 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-0 py-0 text-sm leading-[22px] shadow-none focus:border-0 focus:ring-0"
              mentionFiles={filesQuery.data}
              slashCommands={slashCommandsOverride}
              slashCommandsLoading={slashCommandsLoading}
              initialText={initialDraft || undefined}
            />

            <div className="flex shrink-0 items-center gap-1.5 self-end">
              <ImageAttachmentButton onFilesSelected={addFiles} disabled={disabled || sending} />

              {isRunning ? (
                <button
                  type="button"
                  onClick={onStop}
                  aria-label="Stop agent"
                  className="flex size-7 shrink-0 items-center justify-center rounded-md bg-destructive/15 text-destructive transition-colors hover:bg-destructive/25"
                >
                  <Pause className="size-3.5" />
                </button>
              ) : !splitSendActions ? (
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!canSend}
                  aria-label="Send message"
                  aria-busy={sending}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity disabled:opacity-30"
                >
                  {sending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Send className="size-3.5" />
                  )}
                </button>
              ) : null}
            </div>
          </div>

          {splitSendActions && !isRunning && (
            <SplitSendActions
              actions={splitSendActions}
              disabled={!canSend}
              onAction={handleSplitAction}
            />
          )}
        </div>
      </>
    );
  },
);

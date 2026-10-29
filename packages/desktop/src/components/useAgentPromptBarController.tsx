import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
} from "react";
import { useAgentPromptShortcuts } from "@/hooks/useAgentPromptShortcuts";
import { useIsMobile } from "@/hooks/useIsMobile";
import { stopArmKeyFor } from "@/stores/stop-arm-store";
import { lineCountLabel } from "@/lib/add-to-prompt";
import { setComposerDraft } from "./agent-prompt-draft-restore";
import { composerKeyFor, useComposerContextStore } from "@/stores/composer-context-store";
import { usePromptAttachments } from "@/hooks/usePromptAttachments";
import { usePromptDraft } from "@/hooks/usePromptDraft";
import { usePromptHistory } from "@/hooks/usePromptHistory";
import { usePromptScheduleControl } from "@/hooks/usePromptScheduleControl";
import {
  DEFAULT_PROMPT_COMMAND_POLICY,
  supportsDollarSkillReferences,
} from "@/lib/prompt-command-policy";
import type {
  AgentPromptBarHandle,
  AgentPromptBarProps,
  SplitSendAction,
} from "./agent-prompt-bar-types";
import { useFeaturePromptDraftRestore } from "./agent-prompt-draft-restore";
import { useAgentPromptSend } from "./agent-prompt-send";
import { shouldFocusPromptFromSurfaceClick } from "./agent-prompt-focus";
import type { PromptEditorHandle } from "./prompt-editor/PromptEditor";
import { useDeferredAgentPrompts } from "./useDeferredAgentPrompts";
import { useQueueSend } from "./composer/useQueueSend";
import { useContextualSend } from "./composer/useContextualSend";
import { useVirtualSkillWizard } from "./composer/useVirtualSkillWizard";

function usePromptState(props: AgentPromptBarProps) {
  const editorRef = useRef<PromptEditorHandle>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const [text, setText] = useState("");
  const textRef = useRef(text);
  textRef.current = text;
  const navigatingHistoryRef = useRef(false);
  const restoringDraftRef = useRef(false);
  const interactedRef = useRef(false);
  const sendInFlightRef = useRef(false);
  const hadSpecialStateRef = useRef(false);
  const shouldRestoreFocusRef = useRef(false);
  const draft = usePromptDraft({ featureId: props.featureId });
  useFeaturePromptDraftRestore({
    featureId: props.featureId,
    restoredDraft: draft.initialDraft,
    draftFeatureId: draft.draftFeatureId,
    textRef,
    editorRef,
    restoringDraftRef,
    interactedRef,
    setText,
    isMobile,
  });
  const history = usePromptHistory(props.projectId ?? 0, props.wsSessionId);
  const attachments = usePromptAttachments({
    wsSessionId: props.wsSessionId,
    sessionId: props.sessionId,
    featureId: props.featureId,
    providerId: props.providerId,
  });
  return {
    attachments,
    draft,
    editorRef,
    hadSpecialStateRef,
    history,
    interactedRef,
    isMobile,
    navigatingHistoryRef,
    restoringDraftRef,
    sendInFlightRef,
    setText,
    shouldRestoreFocusRef,
    text,
    textRef,
    wrapperRef,
  };
}

type PromptState = ReturnType<typeof usePromptState>;

function useSpecialPromptState(props: AgentPromptBarProps, state: PromptState) {
  const deferred = useDeferredAgentPrompts({
    pendingPermission: props.pendingPermission,
    pendingPlanApproval: props.pendingPlanApproval,
    pendingQuestions: props.pendingQuestions,
    promptText: state.text,
  });
  const hasSpecialState =
    !!deferred.visiblePermission ||
    !!deferred.visiblePlanApproval ||
    !!deferred.visibleQuestions?.length;
  useEffect(() => {
    if (hasSpecialState) {
      state.hadSpecialStateRef.current = true;
      state.shouldRestoreFocusRef.current = !!state.wrapperRef.current?.contains(
        document.activeElement,
      );
      return;
    }
    if (!state.hadSpecialStateRef.current) return;
    state.hadSpecialStateRef.current = false;
    if (!state.shouldRestoreFocusRef.current) return;
    state.shouldRestoreFocusRef.current = false;
    requestAnimationFrame(() => state.editorRef.current?.focus());
  }, [
    hasSpecialState,
    state.editorRef,
    state.hadSpecialStateRef,
    state.shouldRestoreFocusRef,
    state.wrapperRef,
  ]);
  return useMemo(() => ({ ...deferred, hasSpecialState }), [deferred, hasSpecialState]);
}

type SpecialPromptState = ReturnType<typeof useSpecialPromptState>;

function usePromptSending(
  props: AgentPromptBarProps,
  state: PromptState,
  special: SpecialPromptState,
  isShellCommandMode: boolean,
) {
  const getAttachments = useCallback(
    () => state.attachments.attachments,
    [state.attachments.attachments],
  );
  const addHistoryEntry = useCallback(
    (entry: string): void => {
      if (props.projectId) state.history.addEntry(entry);
    },
    [props.projectId, state.history.addEntry],
  );
  const skillWizard = useVirtualSkillWizard(state.text);
  const send = useAgentPromptSend({
    editorRef: state.editorRef,
    setText: state.setText,
    clearAttachments: state.attachments.clearAttachments,
    restoreAttachments: state.attachments.restoreAttachments,
    saveDraft: state.draft.saveDraft,
    addHistoryEntry,
    getAttachments,
    interactedRef: state.interactedRef,
    sendInFlightRef: state.sendInFlightRef,
  });
  const contextual = useContextualSend(props.featureId, props.sessionId, skillWizard.decorate);
  const hasSendableContent = isShellCommandMode
    ? state.text.slice(1).trim().length > 0 && state.attachments.attachments.length === 0
    : state.text.trim().length > 0 ||
      state.attachments.attachments.length > 0 ||
      contextual.contextItemCount > 0;
  const canSend =
    hasSendableContent && !props.disabled && !send.sending && !special.permissionDeferred;
  const handleSend = useCallback((): void => {
    if (!canSend) return;
    const run = isShellCommandMode ? props.onSend : contextual.withContext(props.onSend);
    void send.runSend(run, state.textRef.current.trim());
  }, [canSend, contextual, isShellCommandMode, props.onSend, send.runSend, state.textRef]);
  const handleSplitAction = useCallback(
    (action: SplitSendAction): void => {
      if (canSend)
        void send.runSend(contextual.withContext(action.onClick), state.textRef.current.trim());
    },
    [canSend, contextual, send.runSend, state.textRef],
  );
  const scheduleControl = usePromptScheduleControl({
    onScheduleRequest: props.onScheduleRequest,
    featureId: props.featureId,
    enabled: canSend && state.text.trim().length > 0,
    textRef: state.textRef,
    decorate: skillWizard.decorate,
    editorRef: state.editorRef,
    setText: state.setText,
    saveDraft: state.draft.saveDraft,
    addHistoryEntry,
    interactedRef: state.interactedRef,
  });
  const handleEnterSend = useCallback((): boolean => {
    if (!canSend) return true;
    if (!isShellCommandMode && props.splitSendActions?.length) {
      handleSplitAction(props.splitSendActions[0]);
    } else {
      handleSend();
    }
    return true;
  }, [canSend, handleSend, handleSplitAction, isShellCommandMode, props.splitSendActions]);
  const queue = useQueueSend({
    sessionId: props.sessionId,
    isRunning: props.status === "agent",
    canSend,
    isShellCommandMode,
    attachmentCount: state.attachments.attachments.length,
    textRef: state.textRef,
    runSend: send.runSend,
    withContext: contextual.withContext,
    handleEnterSend,
  });
  const enter = useEnterOrQueue(props, state, queue, handleEnterSend);
  return {
    canSend,
    canQueue: queue.canQueue,
    queuesOnEnter: enter.queuesOnEnter,
    handleQueue: queue.handleQueue,
    handleModEnterSend: queue.handleModEnterSend,
    handleEnterSend: enter.handleEnterOrQueue,
    handleSend,
    handleSplitAction,
    scheduleControl,
    sending: send.sending,
    skillWizard: skillWizard.state,
  };
}

/**
 * A provider that can't take a prompt mid-turn gets it after the turn: Enter
 * queues rather than promising a steer nobody will acknowledge. Images can't
 * wait in the queue, so a prompt carrying them is sent.
 */
function useEnterOrQueue(
  props: AgentPromptBarProps,
  state: PromptState,
  queue: { canQueue: boolean; handleQueue: () => void },
  handleEnterSend: () => boolean,
) {
  const queuesOnEnter =
    props.status === "agent" &&
    props.steeringAcknowledged === false &&
    state.attachments.attachments.length === 0;
  const { canQueue, handleQueue } = queue;
  const handleEnterOrQueue = useCallback((): boolean => {
    if (queuesOnEnter && canQueue) {
      handleQueue();
      return true;
    }
    return handleEnterSend();
  }, [canQueue, handleEnterSend, handleQueue, queuesOnEnter]);
  return { queuesOnEnter, handleEnterOrQueue };
}

function usePromptEditorActions(props: AgentPromptBarProps, state: PromptState) {
  const clearShellCommandMode = useCallback((): void => {
    state.editorRef.current?.clearShellCommandMode();
  }, [state.editorRef]);
  const handleEditorChange = useCallback(
    (newText: string): void => {
      state.setText(newText);
      // The send-time clear must not wipe the persisted draft: it stays until
      // the prompt is delivered, so an app closed mid-send can restore it.
      if (state.restoringDraftRef.current || state.sendInFlightRef.current) return;
      state.interactedRef.current = true;
      if (state.navigatingHistoryRef.current) {
        state.navigatingHistoryRef.current = false;
        return;
      }
      state.draft.saveDraft(newText);
      state.history.resetNavigation();
    },
    [
      state.draft.saveDraft,
      state.history.resetNavigation,
      state.interactedRef,
      state.navigatingHistoryRef,
      state.restoringDraftRef,
      state.sendInFlightRef,
      state.setText,
    ],
  );
  const lastRecalledRef = useRef<string | null>(null);
  const historyIndexRef = useRef(state.history.historyIndex);
  historyIndexRef.current = state.history.historyIndex;
  const isBrowsingHistory = useCallback(
    (): boolean =>
      historyIndexRef.current >= 0 && state.textRef.current === lastRecalledRef.current,
    [state.textRef],
  );
  const handleArrowUp = useCallback((): string | null => {
    if (!props.projectId || !props.wsSessionId) return null;
    const result = state.history.navigateUp(state.textRef.current);
    if (result !== null) {
      state.navigatingHistoryRef.current = true;
      lastRecalledRef.current = result;
    }
    return result;
  }, [
    props.projectId,
    props.wsSessionId,
    state.history.navigateUp,
    state.navigatingHistoryRef,
    state.textRef,
  ]);
  const handleArrowDown = useCallback((): string | null => {
    if (!props.projectId || !props.wsSessionId || state.history.historyIndex < 0) return null;
    const result = state.history.navigateDown();
    if (result !== null) {
      state.navigatingHistoryRef.current = true;
      lastRecalledRef.current = result;
    }
    return result;
  }, [
    props.projectId,
    props.wsSessionId,
    state.history.historyIndex,
    state.history.navigateDown,
    state.navigatingHistoryRef,
  ]);
  const handlePasteLongText = useCallback(
    (text: string): void => {
      useComposerContextStore.getState().add(composerKeyFor(props.featureId), {
        kind: "pasted",
        label: "Pasted text",
        detail: lineCountLabel(text),
        content: text,
      });
    },
    [props.featureId],
  );
  const handleSurfaceClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (shouldFocusPromptFromSurfaceClick(event.target)) state.editorRef.current?.focus();
    },
    [state.editorRef],
  );
  return {
    clearShellCommandMode,
    handleArrowDown,
    handleArrowUp,
    handleEditorChange,
    handlePasteLongText,
    handleSurfaceClick,
    isBrowsingHistory,
  };
}

export function useAgentPromptBarController(
  props: AgentPromptBarProps,
  ref: ForwardedRef<AgentPromptBarHandle>,
) {
  const promptCommandPolicy = props.promptCommandPolicy ?? DEFAULT_PROMPT_COMMAND_POLICY;
  const state = usePromptState(props);
  const isShellCommandMode = promptCommandPolicy.userShell && state.text.startsWith("!");
  const special = useSpecialPromptState(props, state);
  const sending = usePromptSending(props, state, special, isShellCommandMode);
  const editorActions = usePromptEditorActions(props, state);
  useImperativeHandle(
    ref,
    () => ({
      focusInput: () => state.editorRef.current?.focus(),
      setDraft: (value: string): void =>
        setComposerDraft({ ...state, saveDraft: state.draft.saveDraft }, value),
    }),
    [
      state.draft.saveDraft,
      state.editorRef,
      state.interactedRef,
      state.restoringDraftRef,
      state.setText,
    ],
  );
  useAgentPromptShortcuts({
    agentTabActive: props.agentTabActive ?? true,
    isRunning: props.status === "agent",
    wrapperRef: state.wrapperRef,
    stopArmKey: stopArmKeyFor(props.wsSessionId, props.featureId),
    onOpenModelPicker: props.onOpenModelPicker,
    onToggleMaximize: props.onToggleMaximize,
    onPermissionModeToggle: props.onPermissionModeToggle,
    onCollapse: props.onCollapse,
    onStop: props.onStop,
  });
  const promptCommandHint = [
    "/ commands",
    supportsDollarSkillReferences(promptCommandPolicy) ? "$ skills" : undefined,
    promptCommandPolicy.userShell ? "! shell" : undefined,
  ]
    .filter((hint): hint is string => !!hint)
    .join(", ");
  return {
    editorActions,
    isRunning: props.status === "agent",
    isShellCommandMode,
    promptCommandPolicy,
    promptCommandHint,
    sending,
    special,
    state,
  };
}

export type AgentPromptBarController = ReturnType<typeof useAgentPromptBarController>;

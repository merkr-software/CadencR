import { useUiTranslation } from "@/lib/i18n/ui";
import { useScopedHotkeys } from "@/hooks/useScopedHotkeys";
import { useScopedShortcut } from "@/hooks/useShortcut";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useIsMobile } from "@/hooks/useIsMobile";
import { SendIcon, Loader2 } from "lucide-react";
import { getPermissionPreview } from "./permission-preview";
import { ToolPermissionPromptHeader } from "./ToolPermissionPromptHeader";
import { useToolPermissionActions } from "./useToolPermissionActions";
import {
  PermissionOptionList,
  shouldShortcutAllowFuture,
  shouldShortcutDeny,
} from "./ToolPermissionOptions";

import type {
  PendingPermission,
  PermissionDecisionValue,
  PermissionOption,
} from "@/types/agent-permission";

interface ToolPermissionPromptProps {
  /** The pending permission request to display */
  permission: PendingPermission;
  /** Called when the user makes a decision */
  onDecision: (decision: PermissionDecisionValue, feedback?: string, optionId?: string) => void;
  /** Called when the user closes the gate without answering it */
  onCancel?: () => void;
  /**
   * Folds the request away unanswered, the agent still waiting (phone layout:
   * "Later" replaces the close button, and Escape does the same).
   */
  onLater?: () => void;
  /** When true, disables keyboard shortcuts */
  disableShortcuts?: boolean;
  /**
   * True while a decision for this request is in flight to the backend.
   * Disables the option buttons / shortcuts and shows a spinner on the
   * clicked option so the user does not double-submit while waiting for
   * the ack. Cleared by the store on success or error.
   */
  isSubmitting?: boolean;
}

const FALLBACK_OPTIONS: PermissionOption[] = [
  {
    decision: "allow_once",
    label: "Allow once",
    description: "Approve this tool call only",
    collectFeedback: false,
  },
  {
    decision: "deny",
    label: "Deny",
    description: "Reject this tool call",
    collectFeedback: true,
  },
];

interface ToolPermissionPromptContentProps {
  permission: PendingPermission;
  options: PermissionOption[];
  rawCommand: string | null;
  highlightedIndex: number | null;
  submittedIndex: number | null;
  showFeedback: boolean;
  feedback: string;
  isSubmitting: boolean;
  onCancel?: () => void;
  /** Phone layout only (see `ToolPermissionPromptProps.onLater`). */
  onLater?: () => void;
  phone: boolean;
  onOption: (index: number) => void;
  onFeedbackChange: (feedback: string) => void;
  onDenySubmit: () => void;
}

function ToolPermissionPromptContent({
  permission,
  options,
  rawCommand,
  highlightedIndex,
  submittedIndex,
  showFeedback,
  feedback,
  isSubmitting,
  onCancel,
  onLater,
  phone,
  onOption,
  onFeedbackChange,
  onDenySubmit,
}: ToolPermissionPromptContentProps) {
  return (
    <div className="agent-prompt-gate-panel border-t border-amber-500/30 bg-card px-3 py-2">
      <ToolPermissionPromptHeader
        toolName={permission.toolName}
        onCancel={onLater ? undefined : onCancel}
        onLater={onLater}
      />
      <p className="mb-1.5 text-sm text-foreground">{permission.description}</p>
      {rawCommand && (
        <pre className="mb-3 max-h-40 overflow-auto phone-short:mb-2 phone-short:max-h-16 rounded-md border border-border bg-muted/40 p-2 text-xs text-foreground font-mono whitespace-pre-wrap break-all">
          {rawCommand}
        </pre>
      )}
      <PermissionOptionList
        options={options}
        highlightedIndex={highlightedIndex}
        submittedIndex={submittedIndex}
        isSubmitting={isSubmitting}
        onOption={onOption}
        phone={phone}
      />
      {showFeedback && (
        <DenyFeedbackInput
          feedback={feedback}
          onChange={onFeedbackChange}
          onSubmit={onDenySubmit}
          disabled={isSubmitting}
          showSpinner={
            isSubmitting && submittedIndex !== null && options[submittedIndex]?.decision === "deny"
          }
        />
      )}
    </div>
  );
}

interface DenyFeedbackInputProps {
  feedback: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  showSpinner: boolean;
}

function DenyFeedbackInput({
  feedback,
  onChange,
  onSubmit,
  disabled,
  showSpinner,
}: DenyFeedbackInputProps) {
  const { t } = useUiTranslation();
  return (
    <div className="mt-2 flex items-center gap-2">
      <Input
        value={feedback}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) onSubmit();
        }}
        placeholder={t(
          "conversation.composer.toolPermissionPrompt.reasonForDenyingOptional",
          "Reason for denying (optional)...",
        )}
        className="h-8 border-border/50 bg-muted/40 text-sm shadow-none focus-visible:ring-1 focus-visible:ring-ring/40 phone:h-11"
        autoFocus
        disabled={disabled}
      />
      <Button size="sm" onClick={onSubmit} className="h-8 phone:h-11" disabled={disabled}>
        {showSpinner ? (
          <Loader2 className="mr-1.5 size-3 animate-spin" />
        ) : (
          <SendIcon className="mr-1.5 size-3" />
        )}
        {t("conversation.composer.toolPermissionPrompt.deny", "Deny")}
      </Button>
    </div>
  );
}

interface PermissionHotkeysArgs {
  disableShortcuts: boolean | undefined;
  isSubmitting: boolean;
  options: PermissionOption[];
  onTrigger: (index: number) => void;
}

function usePermissionHotkeys({
  disableShortcuts,
  isSubmitting,
  options,
  onTrigger,
}: PermissionHotkeysArgs): void {
  const allowOnceIndex = options.findIndex((o) => o.decision === "allow_once");
  const allowFutureIndex = options.findIndex((o) => shouldShortcutAllowFuture(o, options));
  const denyIndex = options.findIndex(shouldShortcutDeny);
  const enabled = !disableShortcuts && !isSubmitting;

  // cmd+Y → approve (allow_once)
  useScopedShortcut(
    "perm-allow-once",
    (e) => {
      if (allowOnceIndex < 0 || e.shiftKey) return;
      e.preventDefault();
      onTrigger(allowOnceIndex);
    },
    "agent",
    { enabled },
    [onTrigger, allowOnceIndex],
  );

  // cmd+L → approve future requests when the provider exposes that option
  useScopedShortcut(
    "perm-allow-future",
    (e) => {
      if (allowFutureIndex < 0) return;
      e.preventDefault();
      onTrigger(allowFutureIndex);
    },
    "agent",
    { enabled },
    [onTrigger, allowFutureIndex],
  );

  // cmd+N → reject (deny)
  useScopedShortcut(
    "perm-deny",
    (e) => {
      if (denyIndex < 0) return;
      e.preventDefault();
      onTrigger(denyIndex);
    },
    "agent",
    { enabled },
    [onTrigger, denyIndex],
  );
}

/**
 * Inline permission prompt shown when an agent tool call requires user approval.
 * Displays the tool name, description, request preview, and runtime-provided options.
 */
export function ToolPermissionPrompt({
  permission,
  onDecision,
  onCancel,
  onLater,
  disableShortcuts,
  isSubmitting = false,
}: ToolPermissionPromptProps) {
  const options =
    permission.options && permission.options.length > 0 ? permission.options : FALLBACK_OPTIONS;
  const rawCommand = getPermissionPreview(permission);
  const actions = useToolPermissionActions({ isSubmitting, options, onDecision });
  const phone = useIsMobile();
  const phoneLater = phone ? onLater : undefined;
  // On phone, Escape puts the request off like "Later": stopping takes the composer's Stop.
  const onEscape = phoneLater ?? onCancel;

  usePermissionHotkeys({
    disableShortcuts,
    isSubmitting,
    options,
    onTrigger: actions.handleHotkey,
  });
  useScopedHotkeys(
    "escape",
    (event) => {
      event.preventDefault();
      event.stopPropagation();
      onEscape?.();
    },
    "agent",
    {
      enabled: !!onEscape && !disableShortcuts,
      enableOnFormTags: true,
      enableOnContentEditable: true,
    },
    [onEscape, disableShortcuts],
  );

  return (
    <ToolPermissionPromptContent
      permission={permission}
      options={options}
      rawCommand={rawCommand}
      highlightedIndex={actions.highlightedIndex}
      submittedIndex={actions.submittedIndex}
      showFeedback={actions.showFeedback}
      feedback={actions.feedback}
      isSubmitting={isSubmitting}
      onCancel={onCancel}
      onLater={phoneLater}
      phone={phone}
      onOption={actions.handleOption}
      onFeedbackChange={actions.setFeedback}
      onDenySubmit={actions.handleDenyWithEnter}
    />
  );
}

import { useScopedHotkeys } from "@/hooks/useScopedHotkeys";
import { useScopedShortcut } from "@/hooks/useShortcut";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { KbdShortcut } from "@/components/KbdShortcut";
import { useShortcutKeys } from "@/hooks/useShortcutLabel";
import type { ShortcutId } from "@/lib/shortcuts/registry";
import { SendIcon, Loader2 } from "lucide-react";
import { getPermissionPreview } from "./permission-preview";
import { ToolPermissionPromptHeader } from "./ToolPermissionPromptHeader";
import { useToolPermissionActions } from "./useToolPermissionActions";
import {
  AGENT_OPTION_CARD_BASE,
  AGENT_OPTION_CARD_RESTING,
  AGENT_OPTION_CARD_HIGHLIGHTED,
} from "./agent-prompt-option-card";

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
  onOption,
  onFeedbackChange,
  onDenySubmit,
}: ToolPermissionPromptContentProps) {
  return (
    <div className="agent-prompt-gate-panel border-t border-amber-500/30 bg-card px-3 py-2">
      <ToolPermissionPromptHeader toolName={permission.toolName} onCancel={onCancel} />
      <p className="mb-1.5 text-sm text-foreground">{permission.description}</p>
      {rawCommand && (
        <pre className="mb-3 max-h-40 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-xs text-foreground font-mono whitespace-pre-wrap break-all">
          {rawCommand}
        </pre>
      )}
      <div className="mb-2 flex flex-col gap-1.5">
        {options.map((option, index) => (
          <PermissionOptionButton
            key={`${option.decision}-${option.label}`}
            option={option}
            index={index}
            highlighted={highlightedIndex === index}
            onClick={onOption}
            options={options}
            disabled={isSubmitting}
            showSpinner={isSubmitting && submittedIndex === index}
          />
        ))}
      </div>
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

interface PermissionOptionButtonProps {
  option: PermissionOption;
  index: number;
  highlighted: boolean;
  onClick: (index: number) => void;
  options: PermissionOption[];
  disabled: boolean;
  showSpinner: boolean;
}

function optionLabel(option: PermissionOption): string {
  return option.label.trim().toLowerCase();
}

function isAlwaysApprovalOption(option: PermissionOption): boolean {
  return optionLabel(option).includes("always");
}

function shouldShortcutAllowFuture(option: PermissionOption, options: PermissionOption[]): boolean {
  if (option.decision !== "allow_future") return false;
  const hasAlwaysApproval = options.some(
    (candidate) => candidate.decision === "allow_future" && isAlwaysApprovalOption(candidate),
  );
  return hasAlwaysApproval ? isAlwaysApprovalOption(option) : true;
}

function shouldShortcutDeny(option: PermissionOption): boolean {
  if (option.decision !== "deny") return false;
  const label = optionLabel(option);
  return label === "deny" || label.includes("deny and continue");
}

function shortcutIdForOption(
  option: PermissionOption,
  options: PermissionOption[],
): ShortcutId | undefined {
  if (option.decision === "allow_once") return "perm-allow-once";
  if (shouldShortcutAllowFuture(option, options)) return "perm-allow-future";
  if (shouldShortcutDeny(option)) return "perm-deny";
  return undefined;
}

/** Resolves the key hint through the registry so a rebind updates the badge. */
function PermissionShortcutBadge({ shortcutId }: { shortcutId: ShortcutId }) {
  const keys = useShortcutKeys(shortcutId);
  return <KbdShortcut keys={keys} variant="square" scope="agent" />;
}

function PermissionOptionButton({
  option,
  index,
  highlighted,
  onClick,
  options,
  disabled,
  showSpinner,
}: PermissionOptionButtonProps) {
  const shortcutId = shortcutIdForOption(option, options);
  return (
    <button
      type="button"
      disabled={disabled}
      aria-busy={showSpinner}
      className={cn(
        AGENT_OPTION_CARD_BASE,
        AGENT_OPTION_CARD_RESTING,
        highlighted && AGENT_OPTION_CARD_HIGHLIGHTED,
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-muted/40",
      )}
      onClick={() => onClick(index)}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
        {shortcutId && <PermissionShortcutBadge shortcutId={shortcutId} />}
        {option.label}
        {showSpinner && <Loader2 className="ml-1 size-3.5 animate-spin text-muted-foreground" />}
      </span>
      <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>
    </button>
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
  return (
    <div className="mt-2 flex items-center gap-2">
      <Input
        value={feedback}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) onSubmit();
        }}
        placeholder="Reason for denying (optional)..."
        className="h-8 border-border/50 bg-muted/40 text-sm shadow-none focus-visible:ring-1 focus-visible:ring-ring/40"
        autoFocus
        disabled={disabled}
      />
      <Button size="sm" onClick={onSubmit} className="h-8" disabled={disabled}>
        {showSpinner ? (
          <Loader2 className="mr-1.5 size-3 animate-spin" />
        ) : (
          <SendIcon className="mr-1.5 size-3" />
        )}
        Deny
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
  disableShortcuts,
  isSubmitting = false,
}: ToolPermissionPromptProps) {
  const options =
    permission.options && permission.options.length > 0 ? permission.options : FALLBACK_OPTIONS;
  const rawCommand = getPermissionPreview(permission);
  const actions = useToolPermissionActions({ isSubmitting, options, onDecision });

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
      onCancel?.();
    },
    "agent",
    {
      enabled: !!onCancel && !disableShortcuts,
      enableOnFormTags: true,
      enableOnContentEditable: true,
    },
    [onCancel, disableShortcuts],
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
      onOption={actions.handleOption}
      onFeedbackChange={actions.setFeedback}
      onDenySubmit={actions.handleDenyWithEnter}
    />
  );
}

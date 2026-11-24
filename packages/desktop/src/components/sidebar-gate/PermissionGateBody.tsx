import { useUiTranslation } from "@/lib/i18n/ui";
import { useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { Loader2Icon } from "lucide-react";
import {
  PHONE_PERMISSION_DENY_GROUP_CLASS,
  PHONE_PERMISSION_TONE_BUTTON_CLASS,
  PHONE_PERMISSION_TONE_VARIANT,
  phonePermissionSlots,
  type PermissionOptionKind,
  type PhonePermissionSlot,
} from "@/components/agent-prompt-option-card";
import { Button, type BUTTON_VARIANT_CLASS } from "@/components/ui/button";
import { KeyboardOnlyShortcutHint } from "@/components/KbdShortcut";
import {
  buildOptions,
  permissionContext,
  PENDING_KIND_TEXT_CLASS,
  type PermissionOptionView,
} from "@/components/sidebar-pending-gate";
import type { FeatureGateDecision, FeaturePendingGateResponse } from "@/api/generated";
import { cn } from "@/lib/utils";
import { DenyFeedback } from "./DenyFeedback";
import { ExpandableText } from "./ExpandableText";
import { GATE_BODY_PADDING, GateMessage, gateButtonSize } from "./GateStates";
import { isButton, isTextEntry, pressedDigit, useInitialFocus } from "./gate-keys";

type ButtonVariant = keyof typeof BUTTON_VARIANT_CLASS;

interface PermissionGateBodyProps {
  gate: FeaturePendingGateResponse;
  isSubmitting: boolean;
  respond: (decision: FeatureGateDecision) => void;
  onOpenConversation: () => void;
  autoFocus: boolean;
  touch: boolean;
}

/** The desktop popover's look, in the provider's order. */
const ACTION_VARIANT = {
  allow_once: "default",
  allow_always: "raised",
  deny: "ghost",
} as const;

function desktopActionClass(option: PermissionOptionView): string {
  const isDeny = option.action === "deny";
  return cn(
    // Labels stay whole: a row that can't hold them all wraps instead.
    "max-w-full",
    isDeny ? "shrink-0" : "flex-auto",
    gateButtonSize(false),
    isDeny && "text-destructive hover:bg-destructive/10 hover:text-destructive",
  );
}

function optionKind(option: PermissionOptionView): PermissionOptionKind {
  if (option.action === "deny") return "deny";
  return option.action === "allow_always" ? "allow_more" : "allow_once";
}

/** Permission request: context, the command, then primary / secondary / deny actions. */
export function PermissionGateBody({
  gate,
  isSubmitting,
  respond,
  onOpenConversation,
  autoFocus,
  touch,
}: PermissionGateBodyProps): ReactElement {
  const { t } = useUiTranslation();
  const options = useMemo(() => buildOptions(gate), [gate, t]);
  const context = useMemo(() => permissionContext(gate), [gate]);
  const [denying, setDenying] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const denyOption = options.find((option) => option.action === "deny");
  // Enter never denies: it takes the first action that lets the agent go on.
  const primaryOption = options.find((option) => option.action !== "deny");
  useInitialFocus(rootRef, "[data-gate-action]", autoFocus, denying ? "deny" : "actions");

  const activate = (option: PermissionOptionView): void => {
    if (isSubmitting) return;
    if (option.collectFeedback) {
      setDenying(true);
      return;
    }
    setActiveKey(option.key);
    respond(option.decision);
  };
  const submitDeny = (message: string): void => {
    if (!denyOption || isSubmitting) return;
    setActiveKey(denyOption.key);
    respond(
      denyOption.decision.type === "permission" && message
        ? { ...denyOption.decision, message }
        : denyOption.decision,
    );
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || denying || isTextEntry(event.target)) return;
    const digit = pressedDigit(event);
    const option =
      digit !== null ? options[digit - 1] : event.key === "Enter" ? primaryOption : undefined;
    if (!option || (digit === null && isButton(event.target))) return;
    event.preventDefault();
    // The conversation's own digit hotkeys listen on the document.
    event.stopPropagation();
    activate(option);
  };

  return (
    // The keys are scoped to this body: no global hotkey is registered.
    // oxlint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      ref={rootRef}
      onKeyDown={onKeyDown}
      className={cn("flex flex-col gap-2.5", GATE_BODY_PADDING, touch ? "text-sm" : "text-xs")}
    >
      {context.justification ? <ExpandableText text={context.justification} touch={touch} /> : null}
      <CommandBlock context={context} />
      {options.length === 0 ? (
        <GateMessage
          message={t(
            "sidebar.permissionGateBody.thisRequestCanOnlyBeAnswered",
            "This request can only be answered in the conversation.",
          )}
          touch={touch}
          autoFocus={autoFocus}
          tone="muted"
          onOpenConversation={onOpenConversation}
        />
      ) : denying ? (
        <DenyFeedback
          isSubmitting={isSubmitting}
          touch={touch}
          onSubmit={submitDeny}
          onCancel={() => setDenying(false)}
        />
      ) : (
        <PermissionActions
          options={options}
          touch={touch}
          isSubmitting={isSubmitting}
          activeKey={activeKey}
          onActivate={activate}
        />
      )}
    </div>
  );
}

interface PermissionActionsProps {
  options: PermissionOptionView[];
  touch: boolean;
  isSubmitting: boolean;
  activeKey: string | null;
  onActivate: (option: PermissionOptionView) => void;
}

/**
 * The request's actions: in the provider's order on desktop; on the phone's
 * sheet, toned and ordered as the composer's gate is (`phonePermissionSlots`).
 * Digit keys follow the provider's order either way.
 */
function PermissionActions({
  options,
  touch,
  isSubmitting,
  activeKey,
  onActivate,
}: PermissionActionsProps): ReactElement {
  const { t } = useUiTranslation();
  const action = (
    option: PermissionOptionView,
    index: number,
    variant: ButtonVariant,
    className: string,
  ): ReactElement => (
    <Button
      key={option.key}
      type="button"
      size="sm"
      variant={variant}
      data-gate-action=""
      aria-keyshortcuts={String(index + 1)}
      title={option.description || undefined}
      disabled={isSubmitting}
      className={className}
      onClick={() => onActivate(option)}
    >
      {isSubmitting && activeKey === option.key ? (
        <Loader2Icon
          className="animate-spin"
          aria-label={t("sidebar.permissionGateBody.sending", "Sending")}
        />
      ) : null}
      <span className="truncate">{option.label}</span>
      {index < 9 ? <KeyboardOnlyShortcutHint keys={[String(index + 1)]} /> : null}
    </Button>
  );
  if (!touch) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {options.map((option, index) =>
          action(
            option,
            index,
            ACTION_VARIANT[option.action ?? "allow_once"],
            desktopActionClass(option),
          ),
        )}
      </div>
    );
  }
  const { allowing, denying } = phonePermissionSlots(options, optionKind);
  const phoneAction = ({ option, index, tone }: PhonePermissionSlot<PermissionOptionView>) =>
    action(
      option,
      index,
      PHONE_PERMISSION_TONE_VARIANT[tone],
      cn("w-full max-w-full", gateButtonSize(true), PHONE_PERMISSION_TONE_BUTTON_CLASS[tone]),
    );
  return (
    <div className="flex flex-col gap-2">
      {allowing.map(phoneAction)}
      {denying.length > 0 && (
        <div
          data-permission-deny-group=""
          className={
            allowing.length > 0 ? PHONE_PERMISSION_DENY_GROUP_CLASS : "flex flex-col gap-2"
          }
        >
          {denying.map(phoneAction)}
        </div>
      )}
    </div>
  );
}

function CommandBlock({
  context,
}: {
  context: ReturnType<typeof permissionContext>;
}): ReactElement | null {
  const text = context.command ?? context.toolName;
  if (!text) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {context.command && context.toolName ? (
        <span className={cn("text-[11px] font-medium", PENDING_KIND_TEXT_CLASS.permission)}>
          {context.toolName}
        </span>
      ) : null}
      <pre
        className={cn(
          "max-h-[8lh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border",
          "bg-muted/50 px-2.5 py-2 font-mono text-[11px] leading-snug text-foreground",
        )}
      >
        {text}
      </pre>
    </div>
  );
}

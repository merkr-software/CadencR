import { useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
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

interface PermissionGateBodyProps {
  gate: FeaturePendingGateResponse;
  isSubmitting: boolean;
  respond: (decision: FeatureGateDecision) => void;
  onOpenConversation: () => void;
  autoFocus: boolean;
  touch: boolean;
}

const ACTION_VARIANT = {
  allow_once: "default",
  allow_always: "raised",
  deny: "ghost",
} as const;

function actionClass(option: PermissionOptionView, touch: boolean): string {
  const isDeny = option.action === "deny";
  return cn(
    // Labels stay whole: a row that can't hold them all wraps instead.
    "max-w-full",
    touch ? "w-full" : isDeny ? "shrink-0" : "flex-auto",
    gateButtonSize(touch),
    isDeny && "text-destructive hover:bg-destructive/10 hover:text-destructive",
  );
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
  const options = useMemo(() => buildOptions(gate), [gate]);
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
          message="This request can only be answered in the conversation."
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
        <div className={cn("flex gap-1.5", touch ? "flex-col" : "flex-wrap")}>
          {options.map((option, index) => (
            <Button
              key={option.key}
              type="button"
              size="sm"
              variant={ACTION_VARIANT[option.action ?? "allow_once"]}
              data-gate-action=""
              aria-keyshortcuts={String(index + 1)}
              title={option.description || undefined}
              disabled={isSubmitting}
              className={actionClass(option, touch)}
              onClick={() => activate(option)}
            >
              {isSubmitting && activeKey === option.key ? (
                <Loader2Icon className="animate-spin" aria-label="Sending" />
              ) : null}
              <span className="truncate">{option.label}</span>
              {index < 9 ? <KeyboardOnlyShortcutHint keys={[String(index + 1)]} /> : null}
            </Button>
          ))}
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

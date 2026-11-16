import { memo, useId, type ReactElement } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  conditionDraftError,
  MAX_CONDITION_TIMEOUT_SECONDS,
  type ConditionDraft,
} from "@/lib/schedules/condition";

export interface ConditionEditorProps {
  value: ConditionDraft;
  onChange: (next: ConditionDraft) => void;
  /**
   * The command runs in that conversation's working copy, and is skipped while
   * its agent works; a schedule that starts a new conversation runs it in the
   * project root and is never busy.
   */
  targetsExistingConversation: boolean;
}

/**
 * Gates the schedule on a command: off, the prompt goes out at every scheduled
 * time; on, each scheduled time runs the command first and only a non-zero
 * exit sends the prompt — with the command's output attached.
 */
export const ConditionEditor = memo(function ConditionEditor({
  value,
  onChange,
  targetsExistingConversation,
}: ConditionEditorProps): ReactElement {
  const switchId = useId();
  const error = conditionDraftError(value);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-start gap-2.5">
        <Switch
          id={switchId}
          size="sm"
          className="mt-0.5"
          checked={value.enabled}
          onCheckedChange={(enabled) => onChange({ ...value, enabled })}
        />
        <label htmlFor={switchId} className="flex cursor-pointer flex-col gap-0.5">
          <span className="text-sm text-foreground">Only send when a command fails</span>
          <span className="text-xs text-muted-foreground">
            At each scheduled time, Cadencr runs the command in{" "}
            {targetsExistingConversation
              ? "the conversation's working copy"
              : "the project's root folder"}
            . Exit 0 sends nothing; any other exit sends the prompt with the command&apos;s output.
            {targetsExistingConversation &&
              " Checks are skipped while the agent is working or waiting on you."}
          </span>
        </label>
      </div>

      {value.enabled && (
        <div className="flex flex-col gap-2 pl-[2.125rem]">
          <Input
            value={value.command}
            onChange={(event) => onChange({ ...value, command: event.target.value })}
            placeholder="pnpm test"
            aria-label="Command to check"
            aria-invalid={!value.command.trim() || undefined}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="h-8 font-mono text-[12px]"
          />
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Give up after</span>
            <Input
              type="number"
              min={1}
              max={MAX_CONDITION_TIMEOUT_SECONDS}
              step={1}
              aria-label="Command timeout in seconds"
              value={String(value.timeoutSeconds)}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                if (Number.isFinite(parsed)) onChange({ ...value, timeoutSeconds: parsed });
              }}
              className="h-8 w-20 text-sm no-spinner"
            />
            <span className="text-muted-foreground">seconds</span>
          </div>
          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
});

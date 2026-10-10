import type { ReactElement } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useDebouncedSetting } from "@/hooks/useDebouncedSetting";

export const AUTO_NAME_PROMPT_SETTING_KEY = "auto_name_system_prompt";

const MAX_PROMPT_LENGTH = 2000;
const HINT_ID = "auto-name-prompt-hint";

/**
 * System prompt used by the session auto-namer. Empty (or unset) means the
 * built-in default, so Reset clears the stored setting instead of restoring
 * a duplicated copy of the default text.
 *
 * The Reset button stays outside the textarea's <label>: a label may not
 * contain a second interactive control, and the hint is associated with the
 * textarea through aria-describedby instead.
 */
export function AutoNamePromptSetting(): ReactElement {
  const { value, setValue, isLoading, isSaving } = useDebouncedSetting(
    AUTO_NAME_PROMPT_SETTING_KEY,
    500,
  );
  const currentValue = value ?? "";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor="auto-name-prompt" className="text-xs font-medium">
          Session naming prompt
        </label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 gap-1 px-1.5 text-[11px]"
          disabled={isLoading || isSaving || currentValue.length === 0}
          onClick={() => setValue("")}
        >
          <RotateCcw className="size-3" />
          Reset
        </Button>
      </div>
      <Textarea
        id="auto-name-prompt"
        aria-describedby={HINT_ID}
        value={currentValue}
        maxLength={MAX_PROMPT_LENGTH}
        rows={3}
        disabled={isLoading}
        placeholder="Custom system prompt for the session auto-namer"
        onChange={(event) => setValue(event.target.value)}
      />
      <p id={HINT_ID} className="text-[11px] leading-snug text-muted-foreground">
        {isLoading
          ? "Loading…"
          : isSaving
            ? "Saving…"
            : "Empty uses the built-in default prompt for session auto-naming."}
      </p>
    </div>
  );
}

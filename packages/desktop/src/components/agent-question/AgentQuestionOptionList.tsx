import { memo } from "react";
import { cn } from "@/lib/utils";
import { KbdShortcut, KeyboardOnlyShortcutHint } from "@/components/KbdShortcut";
import { useShortcutKeys } from "@/hooks/useShortcutLabel";
import {
  AGENT_OPTION_CARD_BASE,
  AGENT_OPTION_CARD_RESTING,
  AGENT_OPTION_CARD_SELECTED,
  AGENT_OPTION_CARD_HIGHLIGHTED,
} from "@/components/agent-prompt-option-card";
import { agentQuestionOptionValue, type AgentQuestionOption } from "@/types/agent-question";

interface AgentQuestionOptionListProps {
  options: AgentQuestionOption[];
  selectedOptions: Set<string>;
  highlightedIndex: number | null;
  showOther: boolean;
  freeTextFocused: boolean;
  onOptionToggle: (option: string) => void;
  onOtherToggle: () => void;
  /**
   * `drawer` (default) is the in-chat form. `compact` and `touch` are the sidebar
   * popover's: the digit hints are plain keys that work in the popover, "Other" shows
   * `otherKey` instead of the drawer's shortcut, and clicks keep the focus in the popover.
   */
  layout?: "drawer" | "compact" | "touch";
  /** The key picking "Other" in the popover layouts. */
  otherKey?: string;
}

const LAYOUT_CARD_CLASS = {
  drawer: "",
  compact: "px-2.5 py-1.5",
  touch: "min-h-11 px-3 py-2.5",
} as const;

const LAYOUT_LABEL_CLASS = {
  drawer: "text-sm",
  compact: "text-xs",
  touch: "text-sm",
} as const;

interface OtherOptionButtonProps {
  layout: "drawer" | "compact" | "touch";
  selected: boolean;
  highlighted: boolean;
  otherKey: string | undefined;
  onToggle: () => void;
}

/** The "Other…" card: its own shortcut in the drawer, `otherKey` in the popover layouts. */
function OtherOptionButton({
  layout,
  selected,
  highlighted,
  otherKey,
  onToggle,
}: OtherOptionButtonProps) {
  const otherKeys = useShortcutKeys("q-other");
  const inDrawer = layout === "drawer";
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        AGENT_OPTION_CARD_BASE,
        selected ? AGENT_OPTION_CARD_SELECTED : AGENT_OPTION_CARD_RESTING,
        highlighted && AGENT_OPTION_CARD_HIGHLIGHTED,
        LAYOUT_CARD_CLASS[layout],
      )}
      onClick={(e) => {
        onToggle();
        if (inDrawer) e.currentTarget.blur();
      }}
    >
      <span
        className={cn(
          "font-medium text-foreground",
          !inDrawer && "flex items-center gap-1.5",
          LAYOUT_LABEL_CLASS[layout],
        )}
      >
        {inDrawer ? (
          <span aria-hidden>
            <KbdShortcut keys={otherKeys} variant="square" scope="agent" />
          </span>
        ) : otherKey ? (
          <KeyboardOnlyShortcutHint keys={[otherKey]} />
        ) : null}
        Other…
      </span>
    </button>
  );
}

/** Presentational option cards + "Other" toggle for the agent question drawer. */
function AgentQuestionOptionListComponent({
  options,
  selectedOptions,
  highlightedIndex,
  showOther,
  freeTextFocused,
  onOptionToggle,
  onOtherToggle,
  layout = "drawer",
  otherKey,
}: AgentQuestionOptionListProps) {
  const inDrawer = layout === "drawer";
  const cardClass = LAYOUT_CARD_CLASS[layout];
  const labelClass = LAYOUT_LABEL_CLASS[layout];
  return (
    <div className={cn("flex flex-col gap-1.5", inDrawer && "mb-2")}>
      {options.map((option, optIdx) => {
        const value = agentQuestionOptionValue(option);
        return (
          <button
            key={value}
            type="button"
            aria-pressed={selectedOptions.has(value)}
            aria-keyshortcuts={String(optIdx + 1)}
            className={cn(
              AGENT_OPTION_CARD_BASE,
              selectedOptions.has(value) ? AGENT_OPTION_CARD_SELECTED : AGENT_OPTION_CARD_RESTING,
              highlightedIndex === optIdx && AGENT_OPTION_CARD_HIGHLIGHTED,
              cardClass,
            )}
            onClick={(e) => {
              onOptionToggle(value);
              // Blur so subsequent Enter is handled by the global hotkey (validate)
              // rather than re-triggering this button's click (which would re-toggle).
              // The popover has no global hotkey: blurring would drop its keyboard.
              if (inDrawer) e.currentTarget.blur();
            }}
          >
            <span
              className={cn(
                "font-medium text-foreground",
                !inDrawer && "flex items-center gap-1.5",
                labelClass,
              )}
            >
              {/* The key is announced via aria-keyshortcuts, not read as text. */}
              {inDrawer ? (
                <span aria-hidden>
                  <KbdShortcut
                    keys={[String(optIdx + 1)]}
                    variant="square"
                    scope="agent"
                    disabled={freeTextFocused}
                  />
                </span>
              ) : (
                <KeyboardOnlyShortcutHint keys={[String(optIdx + 1)]} disabled={freeTextFocused} />
              )}
              {option.label}
            </span>
            {option.description && (
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {option.description}
              </span>
            )}
          </button>
        );
      })}
      <OtherOptionButton
        layout={layout}
        selected={showOther}
        highlighted={highlightedIndex === options.length}
        otherKey={otherKey}
        onToggle={onOtherToggle}
      />
    </div>
  );
}

export const AgentQuestionOptionList = memo(AgentQuestionOptionListComponent);

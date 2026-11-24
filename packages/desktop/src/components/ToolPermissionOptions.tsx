import type { CSSProperties, ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { KbdShortcut } from "@/components/KbdShortcut";
import { useShortcutKeys } from "@/hooks/useShortcutLabel";
import type { ShortcutId } from "@/lib/shortcuts/registry";
import { cn } from "@/lib/utils";
import { useUiTranslation } from "@/lib/i18n/ui";
import { permissionOptionCopy } from "@/lib/permission-option-copy";
import type { PermissionOption } from "@/types/agent-permission";
import {
  AGENT_OPTION_CARD_BASE,
  AGENT_OPTION_CARD_HIGHLIGHTED,
  AGENT_OPTION_CARD_RESTING,
  PHONE_PERMISSION_DENY_GROUP_CLASS,
  PHONE_PERMISSION_TONE_CARD_CLASS,
  phonePermissionSlots,
  type PermissionOptionKind,
  type PhonePermissionTone,
} from "./agent-prompt-option-card";

function optionLabel(option: PermissionOption): string {
  return option.label.trim().toLowerCase();
}

function isAlwaysApprovalOption(option: PermissionOption): boolean {
  return optionLabel(option).includes("always");
}

export function shouldShortcutAllowFuture(
  option: PermissionOption,
  options: PermissionOption[],
): boolean {
  if (option.decision !== "allow_future") return false;
  const hasAlwaysApproval = options.some(
    (candidate) => candidate.decision === "allow_future" && isAlwaysApprovalOption(candidate),
  );
  return hasAlwaysApproval ? isAlwaysApprovalOption(option) : true;
}

export function shouldShortcutDeny(option: PermissionOption): boolean {
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

/** The desktop's one card for every option, or a phone tone. */
type OptionTone = "card" | PhonePermissionTone;

const TONE_CLASS: Record<OptionTone, string> = {
  card: AGENT_OPTION_CARD_RESTING,
  ...PHONE_PERMISSION_TONE_CARD_CLASS,
};

const TONE_LABEL_CLASS: Record<OptionTone, string> = {
  card: "text-foreground",
  primary: "text-primary-foreground",
  secondary: "text-foreground",
  destructive: "text-destructive",
};

const TONE_DESCRIPTION_CLASS: Record<OptionTone, string> = {
  card: "text-muted-foreground",
  primary: "text-primary-foreground/80",
  secondary: "text-muted-foreground",
  destructive: "text-muted-foreground",
};

interface PermissionOptionButtonProps {
  option: PermissionOption;
  index: number;
  highlighted: boolean;
  onClick: (index: number) => void;
  options: PermissionOption[];
  disabled: boolean;
  showSpinner: boolean;
  tone?: OptionTone;
}

export function PermissionOptionButton({
  option,
  index,
  highlighted,
  onClick,
  options,
  disabled,
  showSpinner,
  tone = "card",
}: PermissionOptionButtonProps) {
  const { t } = useUiTranslation();
  const shortcutId = shortcutIdForOption(option, options);
  const copy = permissionOptionCopy(t, option);
  return (
    <button
      type="button"
      disabled={disabled}
      aria-busy={showSpinner}
      data-tone={tone}
      className={cn(
        AGENT_OPTION_CARD_BASE,
        TONE_CLASS[tone],
        highlighted && AGENT_OPTION_CARD_HIGHLIGHTED,
        "disabled:cursor-not-allowed disabled:opacity-50",
        tone === "card" && "disabled:hover:bg-muted/40",
        PHONE_SHORT_OPTION_CLASS,
      )}
      onClick={() => onClick(index)}
    >
      <span
        className={cn(
          "flex items-center gap-1.5 text-sm font-medium phone-short:min-w-0",
          TONE_LABEL_CLASS[tone],
        )}
      >
        {shortcutId && <PermissionShortcutBadge shortcutId={shortcutId} />}
        <span className="phone-short:min-w-0 phone-short:truncate">{copy.label}</span>
        {showSpinner && (
          <Loader2 className="ml-1 size-3.5 shrink-0 animate-spin text-muted-foreground" />
        )}
      </span>
      <span
        className={cn("mt-0.5 block text-xs phone-short:truncate", TONE_DESCRIPTION_CLASS[tone])}
      >
        {copy.description}
      </span>
    </button>
  );
}

/**
 * A phone on its side (`phone-short:`): the options share one row, each one
 * line of label over one line of description, so Allow once, the allowing
 * options and Deny all show without scrolling the gate.
 */
const PHONE_SHORT_OPTION_CLASS = "phone-short:min-w-0 phone-short:flex-1 phone-short:py-1.5";
const PHONE_SHORT_ROW_CLASS = "phone-short:flex-row phone-short:items-stretch";
/**
 * The denials' group in that row: a vertical hairline and a gap instead of the
 * portrait's rule above, and a share of the row by its number of options.
 */
const PHONE_SHORT_DENY_GROUP_CLASS =
  "phone-short:mt-0 phone-short:ml-1 phone-short:flex-row phone-short:border-t-0 phone-short:border-l phone-short:pt-0 phone-short:pl-3 phone-short:[flex:var(--deny-count)_1_0%] phone-short:min-w-0";

interface PermissionOptionListProps {
  options: PermissionOption[];
  highlightedIndex: number | null;
  submittedIndex: number | null;
  isSubmitting: boolean;
  onOption: (index: number) => void;
  /** The phone layout: toned options, denials last and set apart. */
  phone: boolean;
}

function permissionOptionKind(option: PermissionOption): PermissionOptionKind {
  if (option.decision === "deny") return "deny";
  return option.decision === "allow_once" ? "allow_once" : "allow_more";
}

/**
 * The request's options, in the provider's order on desktop; in the phone
 * layout, toned and ordered by `phonePermissionSlots` (this call first, the
 * denials last and set apart). Each answers with its provider index.
 */
export function PermissionOptionList({
  options,
  highlightedIndex,
  submittedIndex,
  isSubmitting,
  onOption,
  phone,
}: PermissionOptionListProps): ReactElement {
  const button = (option: PermissionOption, index: number, tone: OptionTone): ReactElement => (
    <PermissionOptionButton
      key={`${option.decision}-${option.label}`}
      option={option}
      index={index}
      highlighted={highlightedIndex === index}
      onClick={onOption}
      options={options}
      disabled={isSubmitting}
      showSpinner={isSubmitting && submittedIndex === index}
      tone={tone}
    />
  );
  if (!phone) {
    return (
      <div className="mb-2 flex flex-col gap-1.5">
        {options.map((option, index) => button(option, index, "card"))}
      </div>
    );
  }
  const { allowing, denying } = phonePermissionSlots(options, permissionOptionKind);
  return (
    <div
      data-permission-options=""
      className={cn("mb-2 flex flex-col gap-2", PHONE_SHORT_ROW_CLASS)}
    >
      {allowing.map(({ option, index, tone }) => button(option, index, tone))}
      {denying.length > 0 && (
        <div
          data-permission-deny-group=""
          style={{ "--deny-count": denying.length } as CSSProperties}
          className={
            allowing.length > 0
              ? cn(PHONE_PERMISSION_DENY_GROUP_CLASS, PHONE_SHORT_DENY_GROUP_CLASS)
              : cn("flex flex-col gap-2", PHONE_SHORT_ROW_CLASS, "phone-short:flex-1")
          }
        >
          {denying.map(({ option, index, tone }) => button(option, index, tone))}
        </div>
      )}
    </div>
  );
}

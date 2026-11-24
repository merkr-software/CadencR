import type { ReactElement } from "react";
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
      )}
      onClick={() => onClick(index)}
    >
      <span className={cn("flex items-center gap-1.5 text-sm font-medium", TONE_LABEL_CLASS[tone])}>
        {shortcutId && <PermissionShortcutBadge shortcutId={shortcutId} />}
        {copy.label}
        {showSpinner && <Loader2 className="ml-1 size-3.5 animate-spin text-muted-foreground" />}
      </span>
      <span className={cn("mt-0.5 block text-xs", TONE_DESCRIPTION_CLASS[tone])}>
        {copy.description}
      </span>
    </button>
  );
}

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
    <div className="mb-2 flex flex-col gap-2">
      {allowing.map(({ option, index, tone }) => button(option, index, tone))}
      {denying.length > 0 && (
        <div
          data-permission-deny-group=""
          className={
            allowing.length > 0 ? PHONE_PERMISSION_DENY_GROUP_CLASS : "flex flex-col gap-2"
          }
        >
          {denying.map(({ option, index, tone }) => button(option, index, tone))}
        </div>
      )}
    </div>
  );
}

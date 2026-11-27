/**
 * Shared styling for the option tiles rendered inline in the agent prompt area
 * by the question drawer (`AgentQuestionDrawer`) and the tool-permission prompt
 * (`ToolPermissionPrompt`). Both rendered the same tile by copy-pasting the
 * class strings; this is the single source of truth.
 *
 * The `agent-option-card` marker class is also the CSS hook the Frost theme uses
 * to frost these tiles so they read as crisp glass tappable surfaces instead of
 * the near-invisible `bg-muted/40` default (see `theme-frost.css`).
 */

import { BUTTON_VARIANT_CLASS } from "@/components/ui/button";

/** Base shape shared by every tile, regardless of state. */
export const AGENT_OPTION_CARD_BASE =
  "agent-option-card w-full rounded-md border px-3 py-2 text-left transition-colors";

/** Resting (unselected) appearance. */
export const AGENT_OPTION_CARD_RESTING = "border-border bg-muted/40 hover:bg-muted/50";

/** Selected appearance (question drawer single/multi select). */
export const AGENT_OPTION_CARD_SELECTED = "border-primary bg-primary/5 ring-2 ring-primary/30";

/** Keyboard-highlighted appearance (arrow-key navigation flash). */
export const AGENT_OPTION_CARD_HIGHLIGHTED = "ring-2 ring-blue-400 bg-blue-50/10 transition-none";

/**
 * How a permission option reads in the phone layout, in the composer's gate
 * (`ToolPermissionOptions`) and in the sidebar's quick-reply sheet
 * (`PermissionGateBody`): allowing this call is the primary action, allowing
 * more a secondary one, denying a destructive one. The desktop keeps the
 * provider's order and its own look.
 */
export type PhonePermissionTone = "primary" | "secondary" | "destructive";

/** What a permission option does, as far as its phone tone and place go. */
export type PermissionOptionKind = "allow_once" | "allow_more" | "deny";

export interface PhonePermissionSlot<T> {
  option: T;
  /** The option's place in the provider's list: what answers the request. */
  index: number;
  tone: PhonePermissionTone;
}

/**
 * The phone layout's order: the first "allow once" (primary) on top, the other
 * allowing options (secondary) in the provider's order, then the denials
 * (destructive), which go last and set apart so a slip of the thumb from
 * "Allow" never lands on "Deny". Each keeps its provider index.
 */
export function phonePermissionSlots<T>(
  options: readonly T[],
  kindOf: (option: T) => PermissionOptionKind,
): { allowing: PhonePermissionSlot<T>[]; denying: PhonePermissionSlot<T>[] } {
  const indexed = options.map((option, index) => ({ option, index, kind: kindOf(option) }));
  const primary = indexed.find(({ kind }) => kind === "allow_once");
  const allowing: PhonePermissionSlot<T>[] = [];
  if (primary) allowing.push({ option: primary.option, index: primary.index, tone: "primary" });
  for (const { option, index, kind } of indexed) {
    if (kind !== "deny" && index !== primary?.index) {
      allowing.push({ option, index, tone: "secondary" });
    }
  }
  const denying = indexed
    .filter(({ kind }) => kind === "deny")
    .map(({ option, index }): PhonePermissionSlot<T> => ({ option, index, tone: "destructive" }));
  return { allowing, denying };
}

/** The denials' group under the allowing options: a hairline and a gap apart. */
export const PHONE_PERMISSION_DENY_GROUP_CLASS = "mt-2 flex flex-col gap-2 border-t pt-4";

/** Each tone as a `Button` variant, for a gate drawn with buttons. */
export const PHONE_PERMISSION_TONE_VARIANT = {
  primary: "default",
  secondary: "raised",
  destructive: "ghost",
} as const satisfies Record<PhonePermissionTone, keyof typeof BUTTON_VARIANT_CLASS>;

/** Deny's outline, on a button (`ghost`) or a card alike. */
const PHONE_PERMISSION_DESTRUCTIVE_CLASS =
  "border border-destructive/50 bg-transparent text-destructive hover:bg-destructive/10 hover:text-destructive";

/** Classes a tone adds to a `Button` of `PHONE_PERMISSION_TONE_VARIANT`. */
export const PHONE_PERMISSION_TONE_BUTTON_CLASS: Record<PhonePermissionTone, string> = {
  primary: "",
  secondary: "",
  destructive: PHONE_PERMISSION_DESTRUCTIVE_CLASS,
};

/**
 * Each tone on an option card (`AGENT_OPTION_CARD_BASE`). The primary card is
 * the default button's fill; its `border-primary` and the destructive card's
 * `data-tone` keep the Frost theme's tile wash off them (`theme-frost.css`).
 */
export const PHONE_PERMISSION_TONE_CARD_CLASS: Record<PhonePermissionTone, string> = {
  primary: `min-h-11 border-primary ${BUTTON_VARIANT_CLASS[PHONE_PERMISSION_TONE_VARIANT.primary]}`,
  secondary: `min-h-11 ${AGENT_OPTION_CARD_RESTING}`,
  destructive: `min-h-11 ${PHONE_PERMISSION_DESTRUCTIVE_CLASS}`,
};

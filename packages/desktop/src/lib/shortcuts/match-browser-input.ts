import { matchesKeyboardEvent, parseHotkey } from "@tanstack/hotkeys";

import type { BrowserShortcutBinding } from "../../shared/browser-types";
import { expandCharacterHotkey } from "./character-hotkeys";
import { tokensToHotkeyString } from "./resolve";

export interface BrowserShortcutInput {
  key: string;
  code: string;
  control?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
}

export type BrowserShortcutInputMatcher = (input: BrowserShortcutInput) => boolean;

interface CompiledVariant {
  exactKeys?: string[];
  parsed: ReturnType<typeof parseHotkey>;
}

export function compileBrowserShortcutBinding(
  binding: BrowserShortcutBinding,
  platform: "mac" | "windows" | "linux",
): BrowserShortcutInputMatcher {
  const combos = [binding.keys, binding.altKeys].filter(
    (keys): keys is string[] => Array.isArray(keys) && keys.length > 0,
  );
  const variants: CompiledVariant[] = combos.flatMap((keys) =>
    expandCharacterHotkey(tokensToHotkeyString(keys)).map((variant) => ({
      exactKeys: variant.exactKeys,
      parsed: parseHotkey(variant.hotkey, platform),
    })),
  );
  return (input) => variants.some((variant) => variantMatchesInput(input, variant, platform));
}

/** Match Electron guest input through the same resolver used by renderer shortcuts. */
export function matchesBrowserShortcutInput(
  input: BrowserShortcutInput,
  binding: BrowserShortcutBinding,
  platform: "mac" | "windows" | "linux",
): boolean {
  return compileBrowserShortcutBinding(binding, platform)(input);
}

function variantMatchesInput(
  input: BrowserShortcutInput,
  variant: CompiledVariant,
  platform: "mac" | "windows" | "linux",
): boolean {
  // Match the renderer's explicit Shift variants, not TanStack's implicit Shift.
  if (Boolean(input.shift) !== variant.parsed.shift) return false;
  if (variant.exactKeys && !variant.exactKeys.includes(input.key)) return false;
  // Adapt Electron's modifier names to the KeyboardEvent names used by TanStack.
  const event = {
    key: input.key,
    code: input.code,
    ctrlKey: Boolean(input.control),
    shiftKey: Boolean(input.shift),
    altKey: Boolean(input.alt),
    metaKey: Boolean(input.meta),
  } as KeyboardEvent;
  return matchesKeyboardEvent(event, variant.parsed, platform);
}

export interface CharacterHotkeyVariant {
  exactKeys?: string[];
  hotkey: string;
}

function isShiftToken(token: string): boolean {
  return token.trim().toLowerCase() === "shift";
}

function isSingleNonLetterCharacter(key: string): boolean {
  return key.length === 1 && !/^\p{Letter}$/u.test(key);
}

function withOptionalShift(
  modifiers: string[],
  key: string,
  exactKey: string,
): CharacterHotkeyVariant[] {
  return [
    { hotkey: [...modifiers, key].join("+"), exactKeys: [exactKey] },
    { hotkey: [...modifiers, "Shift", key].join("+"), exactKeys: [exactKey] },
  ];
}

function characterVariant(
  modifiers: string[],
  key: string,
  exactKeys: string[],
): CharacterHotkeyVariant {
  return { hotkey: [...modifiers, key].join("+"), exactKeys };
}

/**
 * Layout-robust expansion for the keyboard-shortcuts/help chord (⌘⇧? on
 * macOS). Matching is by `event.key` throughout (each variant is gated by
 * `exactKeys` on `event.key`, then confirmed by the engine matcher). The
 * trouble is that the char `event.key` reports for the `?` key varies: while a
 * Cmd/Meta modifier is held, macOS hands us the *base* (unshifted) character,
 * so the labelled `?` key arrives mangled — as `/` on QWERTY (Shift+/) and as
 * `,` on AZERTY (Shift+Comma) — instead of `?`. We therefore accept any of:
 *
 *   1. `?` — the un-mangled char; Shift optional so both `⌘?` and `⌘⇧?` fire;
 *   2. `/` — the QWERTY mangled form, Shift required;
 *   3. `,` — the AZERTY mangled form, Shift required.
 *
 * `exactKeys` keeps each variant pinned to its own char, so an unrelated
 * shifted key (e.g. QWERTY `<`, which reports `event.key === "<"`) never opens
 * the modal, and plain `⌘/` stays free for the editor's comment toggle.
 */
function questionVariants(modifiers: string[]): CharacterHotkeyVariant[] {
  const base = modifiers.filter((modifier) => !isShiftToken(modifier));
  return [
    { hotkey: [...base, "?"].join("+"), exactKeys: ["?"] },
    { hotkey: [...base, "Shift", "?"].join("+"), exactKeys: ["?"] },
    { hotkey: [...base, "Shift", "/"].join("+"), exactKeys: ["/"] },
    { hotkey: [...base, "Shift", ","].join("+"), exactKeys: [","] },
  ];
}

export function expandCharacterHotkey(hotkey: string): CharacterHotkeyVariant[] {
  const parts = hotkey.split("+").map((part) => part.trim());
  const key = parts.at(-1);
  if (!key) return [{ hotkey }];

  const modifiers = parts.slice(0, -1);
  const hasExplicitShift = modifiers.some(isShiftToken);

  if (key === "Plus") {
    const equalKey = [
      characterVariant(modifiers, "=", ["+"]),
      characterVariant([...modifiers, "Shift"], "=", ["+", "="]),
    ];
    const slashKey = withOptionalShift(modifiers, "/", "+");
    if (hasExplicitShift) {
      return [
        characterVariant(modifiers, "=", ["+", "="]),
        characterVariant(modifiers, "/", ["+"]),
      ];
    }
    return [...equalKey, ...slashKey];
  }

  if (key === "-") return [{ hotkey, exactKeys: ["-"] }];

  if (key === "?") return questionVariants(modifiers);

  if (!isSingleNonLetterCharacter(key)) return [{ hotkey }];
  if (hasExplicitShift) return [{ hotkey }];

  return withOptionalShift(modifiers, key, key);
}

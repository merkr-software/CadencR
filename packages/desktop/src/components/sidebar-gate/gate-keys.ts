import { useEffect, useRef, type KeyboardEvent, type RefObject } from "react";

const DIGIT_CODE = /^(?:Digit|(Numpad))([1-9])$/;

/**
 * The digit 1-9 a key press types, or null. Reads `code` first: on AZERTY an
 * unshifted digit key reports `&` or `é` as its `key`. Any modifier but Shift
 * makes it a different shortcut.
 */
export function pressedDigit(event: KeyboardEvent): number | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return null;
  const isDigitKey = /^[1-9]$/.test(event.key);
  const [, pad, fromCode] = DIGIT_CODE.exec(event.code) ?? [];
  // The numpad with NumLock off reports navigation keys (End, ArrowDown...) on the digit codes.
  const raw = fromCode && (!pad || isDigitKey) ? fromCode : isDigitKey ? event.key : null;
  return raw ? Number(raw) : null;
}

/** True when typing goes to this element: a digit or Enter there is text, not a shortcut. */
export function isTextEntry(target: EventTarget): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/** Enter on a button already clicks it; only Enter anywhere else needs the primary action. */
export function isButton(target: EventTarget): boolean {
  return target instanceof HTMLButtonElement;
}

/**
 * Moves the focus to the first match of `selector` inside `root`: on mount when
 * `onMount` (the user opened the popover), and every time `resetKey` changes
 * afterwards (the user's own step to the next question took the focused button away).
 */
export function useInitialFocus(
  root: RefObject<HTMLElement | null>,
  selector: string,
  onMount: boolean,
  resetKey: string | number,
): void {
  // The key last focused for: a re-run with the same key (StrictMode runs
  // effects twice) is not a step, so it never takes focus by itself.
  const lastKey = useRef<string | number | null>(null);
  useEffect(() => {
    const previous = lastKey.current;
    lastKey.current = resetKey;
    const focus = previous === null ? onMount : previous !== resetKey;
    if (focus) root.current?.querySelector<HTMLElement>(selector)?.focus();
    // `onMount` only matters for the first run.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [root, selector, resetKey]);
}

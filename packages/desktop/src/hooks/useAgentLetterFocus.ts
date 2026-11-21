import { useEffect, useRef } from "react";
import { useWorkspaceActivity } from "@/components/workspace-pool/workspace-activity";
import { getActiveFocusZone } from "@/lib/focus-zones";
import {
  getDeepestActiveElement,
  hasActiveTextSelection,
  isEditableShortcutTarget,
} from "@/lib/shortcuts/dom-targets";

const OPEN_OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  "[data-radix-popper-content-wrapper]",
].join(", ");

interface UseAgentLetterFocusOptions {
  enabled: boolean;
  onFocus: () => void;
}

export function isAgentFocusLetterKey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.isComposing || event.key === "Process") return false;
  return event.key.length === 1 && /^\p{L}$/u.test(event.key);
}

export function shouldFocusAgentFromKeydown(event: KeyboardEvent): boolean {
  if (!isAgentFocusLetterKey(event)) return false;
  const focusZone = getActiveFocusZone();
  if (focusZone && focusZone !== "main-content") return false;
  if (hasActiveTextSelection()) return false;
  if (isEditableShortcutTarget(event.target)) return false;
  const activeElement = getDeepestActiveElement();
  if (isEditableShortcutTarget(activeElement)) return false;
  return !isOverlayTarget(activeElement);
}

export function useAgentLetterFocus({ enabled, onFocus }: UseAgentLetterFocusOptions): void {
  const onFocusRef = useRef(onFocus);

  useEffect(() => {
    onFocusRef.current = onFocus;
  }, [onFocus]);

  // A workspace kept mounted but hidden must not pull focus into itself.
  const activity = useWorkspaceActivity();
  useEffect(() => {
    if (!enabled) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!activity.isActive() || !shouldFocusAgentFromKeydown(event)) return;
      onFocusRef.current();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activity, enabled]);
}

function isOverlayTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(OPEN_OVERLAY_SELECTOR) !== null;
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { useScopedShortcut } from "@/hooks/useShortcut";
import type { ShortcutId } from "@/lib/shortcuts/registry";
import type { PromptEditorHandle } from "@/components/prompt-editor/PromptEditor";
import { wizardHolds, wizardOwnsKeys } from "./skill-wizard-focus";

export interface SkillWizardFocus {
  /** The wizard's section, once mounted. */
  section: HTMLElement | null;
  /** Keys set the spawned session: focus is in the wizard or a picker it opened. */
  active: boolean;
  sectionProps: {
    ref: (node: HTMLElement | null) => void;
    onFocus: () => void;
    onBlur: (event: FocusEvent<HTMLElement>) => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  };
}

/**
 * The wizard's half of the composer's keyboard: which of prompt and wizard
 * owns the keys, the shortcut that moves between them, and Esc back to the
 * prompt. The prompt's own shortcuts are untouched while the prompt has focus.
 */
export function useSkillWizardFocus({
  editorRef,
  shortcutsEnabled,
}: {
  editorRef: RefObject<PromptEditorHandle | null>;
  shortcutsEnabled: boolean;
}): SkillWizardFocus {
  const [section, setSection] = useState<HTMLElement | null>(null);
  const [focused, setFocused] = useState(false);
  // A hidden pane or disabled shortcuts never leave the wizard holding the keys.
  const active = focused && shortcutsEnabled;

  // Controls get replaced under focus — a picked model swaps out "Agent picks
  // the model", a mode change remounts its button to flash — which drops focus
  // to <body> with no blur. Put it back on the wizard's first instrument as soon
  // as the DOM changes: the wizard's own subtree, or a picker it portaled out.
  useEffect(() => {
    if (!active || !section) return undefined;
    // Checked a frame later: mid-Tab, focus sits on <body> between blur and focus.
    let frame = 0;
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const visible = section.isConnected && section.offsetParent !== null;
        if (visible && document.activeElement === document.body) focusFirstControl(section);
      });
    });
    observer.observe(section, { childList: true, subtree: true });
    observer.observe(document.body, { childList: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [active, section]);

  useScopedShortcut(
    "agent-skill-wizard",
    (event) => {
      const current = document.activeElement;
      if (!section || !(current instanceof Element)) return;
      if (wizardOwnsKeys(section)) {
        event.preventDefault();
        editorRef.current?.focus();
        return;
      }
      // Only the composer the user is typing in answers, never a sibling pane's.
      if (!section.closest("[data-agent-prompt-bar='true']")?.contains(current)) return;
      event.preventDefault();
      focusFirstControl(section);
    },
    "agent",
    { enabled: shortcutsEnabled && section !== null },
  );

  const onFocus = useCallback(() => setFocused(true), []);
  const onBlur = useCallback((event: FocusEvent<HTMLElement>) => {
    if (!wizardHolds(event.currentTarget, event.relatedTarget)) setFocused(false);
  }, []);
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      // Keys from a portaled picker bubble here through React; they're its own.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      editorRef.current?.focus();
    },
    [editorRef],
  );

  return { section, active, sectionProps: { ref: setSection, onFocus, onBlur, onKeyDown } };
}

/** The wizard section its instruments' shortcuts answer for. */
export const SkillWizardSection = createContext<HTMLElement | null>(null);

/**
 * A composer chord retargeted at the wizard: it runs, and consumes the key,
 * only while this wizard owns the keys — checked at the keypress, not from
 * focus state that a missed blur could leave stale.
 */
export function useWizardShortcut(id: ShortcutId, run: () => void, enabled: boolean): void {
  const section = useContext(SkillWizardSection);
  useScopedShortcut(
    id,
    (event) => {
      if (!section || !wizardOwnsKeys(section)) return;
      event.preventDefault();
      run();
    },
    "agent",
    { enabled: enabled && section !== null },
  );
}

function focusFirstControl(section: HTMLElement): void {
  section.querySelector<HTMLElement>("[role=group] button")?.focus();
}

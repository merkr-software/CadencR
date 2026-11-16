import { useLayoutEffect, useRef, type RefObject, type MutableRefObject } from "react";
import type { PromptEditorHandle } from "./prompt-editor/PromptEditor";

interface FeaturePromptDraftRestoreArgs {
  featureId: number | undefined;
  restoredDraft: string | null;
  draftFeatureId: number | null;
  textRef: MutableRefObject<string>;
  editorRef: RefObject<PromptEditorHandle | null>;
  restoringDraftRef: MutableRefObject<boolean>;
  /**
   * True once the user has typed in or sent from the current feature's input.
   * The hook resets it to `false` on every feature switch; the caller flips it
   * to `true` on user edits and sends. Auto-restore is suppressed while it is
   * `true` so a late draft-query refetch can't re-inject text the user already
   * cleared by sending (the input is empty then, so `textRef` alone is not
   * enough to tell "untouched" from "just sent").
   */
  interactedRef: MutableRefObject<boolean>;
  setText: (text: string) => void;
  /** Phones: restore the draft text without focusing (avoids popping the keyboard). */
  isMobile: boolean;
}

export function useFeaturePromptDraftRestore({
  featureId,
  restoredDraft,
  draftFeatureId,
  textRef,
  editorRef,
  restoringDraftRef,
  interactedRef,
  setText,
  isMobile,
}: FeaturePromptDraftRestoreArgs): void {
  const prevFeatureIdRef = useRef(featureId);
  useLayoutEffect(() => {
    const prevFeatureId = prevFeatureIdRef.current;
    prevFeatureIdRef.current = featureId;
    const featureChanged = prevFeatureId !== featureId;
    // Arriving at a feature re-arms auto-restore for it.
    if (featureChanged) interactedRef.current = false;
    const draftBelongsToFeature = draftFeatureId != null && draftFeatureId === featureId;
    const nextText = featureChanged
      ? draftBelongsToFeature
        ? (restoredDraft ?? "")
        : ""
      : restoredDraft;
    if (nextText == null) return;
    // Same feature: only auto-apply while the input is still untouched. Once the
    // user has typed or sent, the editor is theirs — never clobber it with a
    // (possibly stale) draft delivered by a later query refetch.
    if (!featureChanged && (textRef.current || interactedRef.current)) return;
    restoringDraftRef.current = true;
    setText(nextText);
    // On phones, restore the draft without moving the selection — that would
    // focus the editor and pop the on-screen keyboard over the transcript.
    editorRef.current?.setText(nextText, !isMobile);
    queueMicrotask(() => {
      restoringDraftRef.current = false;
    });
  }, [
    draftFeatureId,
    editorRef,
    featureId,
    interactedRef,
    isMobile,
    restoredDraft,
    restoringDraftRef,
    setText,
    textRef,
  ]);
}

interface ComposerDraftTarget {
  restoringDraftRef: MutableRefObject<boolean>;
  setText: (text: string) => void;
  editorRef: RefObject<PromptEditorHandle | null>;
  interactedRef: MutableRefObject<boolean>;
  saveDraft: (text: string | null) => void;
}

/**
 * Replace the draft programmatically (history recall, a "retry" affordance):
 * saved once, here — the editor's own change event is muted meanwhile so it
 * neither saves it again nor drops out of history navigation.
 */
export function setComposerDraft(target: ComposerDraftTarget, value: string): void {
  target.restoringDraftRef.current = true;
  target.setText(value);
  target.editorRef.current?.setText(value, true);
  target.interactedRef.current = true;
  target.saveDraft(value);
  queueMicrotask(() => {
    target.restoringDraftRef.current = false;
  });
}

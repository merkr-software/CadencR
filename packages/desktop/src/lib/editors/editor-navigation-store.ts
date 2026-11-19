import { create } from "zustand";
import type { EditorOpenFileParams } from "@cadencr/tab-sdk/protocol";

interface OpenedEditorFile {
  backendId: string;
  params: EditorOpenFileParams;
}
interface EditorFallback {
  backendId: string;
  reason: string;
}
interface EditorNavigationState {
  engaged: Readonly<Record<number, string>>;
  opened: Readonly<Record<number, OpenedEditorFile>>;
  fallbacks: Readonly<Record<number, EditorFallback>>;
}

/** UI state only; file paths change after the selected backend acknowledges. */
export const useEditorNavigationStore = create<EditorNavigationState>(() => ({
  engaged: {},
  opened: {},
  fallbacks: {},
}));

export function rememberEditorSurface(featureId: number, backendId: string): void {
  if (useEditorNavigationStore.getState().engaged[featureId] === backendId) return;
  useEditorNavigationStore.setState((state) => ({
    engaged: { ...state.engaged, [featureId]: backendId },
  }));
}

export function rememberEditorFile(
  featureId: number,
  backendId: string,
  params: EditorOpenFileParams,
): void {
  useEditorNavigationStore.setState((state) => ({
    opened: { ...state.opened, [featureId]: { backendId, params } },
  }));
}

export function setEditorFallback(featureId: number, backendId: string, reason: string): void {
  useEditorNavigationStore.setState((state) => ({
    fallbacks: { ...state.fallbacks, [featureId]: { backendId, reason } },
  }));
}

export function clearEditorFallback(featureId: number): void {
  useEditorNavigationStore.setState((state) => {
    const fallbacks = { ...state.fallbacks };
    delete fallbacks[featureId];
    return { fallbacks };
  });
}

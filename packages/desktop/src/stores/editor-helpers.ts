import {
  isUntitledPath,
  type EditorFeatureState,
  type EditorPaneState,
  type EditorSplitNode,
  type EditorTab,
} from "./editor-store-types";

// ---------------------------------------------------------------------------
// Pane state helpers
// ---------------------------------------------------------------------------

export const DEFAULT_PANE_ID = "main";

export const defaultPaneState: EditorPaneState = {
  tabs: [],
  activeFilePath: null,
};

const defaultSplitTree: EditorSplitNode = { type: "leaf", id: DEFAULT_PANE_ID };

export const defaultFeatureState: EditorFeatureState = {
  splitTree: defaultSplitTree,
  panes: { [DEFAULT_PANE_ID]: { ...defaultPaneState } },
  activePaneId: DEFAULT_PANE_ID,
  sidebarVisible: true,
};

/**
 * Whether a conversation's editor holds work that lives only in its open views:
 * a tab with unsaved edits, or an untitled buffer (whose text is in its view
 * alone, so any open one counts). Unmounting the editor would lose it.
 */
export function hasUnsavedEditorWork(feature: EditorFeatureState | undefined): boolean {
  if (feature === undefined) return false;
  return Object.values(feature.panes).some((pane) =>
    pane.tabs.some((tab) => tab.isDirty || isUntitledPath(tab.filePath)),
  );
}

export function getFileName(filePath: string): string {
  return filePath.split("/").at(-1) ?? filePath;
}

/** Compute disambiguated names for all tabs in a pane. */
export function disambiguateTabNames(tabs: EditorTab[]): EditorTab[] {
  const nameCounts = new Map<string, number>();
  for (const t of tabs) {
    nameCounts.set(t.fileName, (nameCounts.get(t.fileName) ?? 0) + 1);
  }
  return tabs.map((t) => {
    if ((nameCounts.get(t.fileName) ?? 0) > 1) {
      const parts = t.filePath.split("/");
      const disambig = parts.length >= 2 ? `${parts.at(-2)}/${t.fileName}` : t.fileName;
      return { ...t, disambiguatedName: disambig };
    }
    return { ...t, disambiguatedName: t.fileName };
  });
}

export function updatePane(
  feature: EditorFeatureState,
  paneId: string,
  updater: (pane: EditorPaneState) => EditorPaneState,
): EditorFeatureState {
  const pane = feature.panes[paneId] ?? { ...defaultPaneState };
  return { ...feature, panes: { ...feature.panes, [paneId]: updater(pane) } };
}

export function updateFeature(
  state: { features: Record<number, EditorFeatureState> },
  featureId: number,
  next: EditorFeatureState,
): { features: Record<number, EditorFeatureState> } {
  return { features: { ...state.features, [featureId]: next } };
}

export function nextPaneId(): string {
  return `editor-pane-${crypto.randomUUID()}`;
}

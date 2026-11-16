import type { StoreApi } from "zustand";

// Sentinel artifact-type for tabs that point at a working-tree file rather than
// a saved artifact (PRD, plan, …). Lived in the hand-written API client; moved
// here when generation was restored.
export const DEFAULT_ARTIFACT_TYPE = "default";

// ---------------------------------------------------------------------------
// State shape types
// ---------------------------------------------------------------------------

export type SplitOrientation = "horizontal" | "vertical";
export type Direction = "left" | "right" | "up" | "down";

export interface EditorTab {
  filePath: string;
  fileName: string;
  disambiguatedName: string;
  isDirty: boolean;
  cursorPosition: { line: number; col: number };
  /** When set, the editor scrolls to this line on next load and clears it. */
  pendingGoToLine?: number;
  isArtifact?: boolean;
  artifactFeatureId?: number;
  artifactPhaseSlug?: string;
  artifactType?: string;
}

export interface EditorPaneState {
  tabs: EditorTab[];
  activeFilePath: string | null;
}

export type EditorLeaf = { type: "leaf"; id: string };
export type EditorSplit = {
  type: "split";
  orientation: SplitOrientation;
  children: [EditorSplitNode, EditorSplitNode];
};
export type EditorSplitNode = EditorLeaf | EditorSplit;

export interface EditorFeatureState {
  splitTree: EditorSplitNode;
  panes: Record<string, EditorPaneState>;
  activePaneId: string;
  sidebarVisible: boolean;
  /**
   * Auto layout tucked the file tree away because the Editor opened in a
   * narrow pane beside the agent. Session-only: the persisted preference
   * must not reopen it, and the user's next toggle clears it.
   */
  sidebarAutoHidden?: boolean;
}

// Default max tabs — can be overridden via settings in the component layer
export const DEFAULT_MAX_TABS = 10;

// Sentinel URI scheme for never-saved scratch buffers. Mirrors the trick
// `artifact://` uses: keeps a single `filePath`-keyed identity and lets all
// the disambiguation / save-registry / dirty plumbing stay untouched. The
// scheme matches the path *prefix*, the UUID after it makes each untitled
// buffer unique per pane.
export const UNTITLED_PATH_PREFIX = "untitled://";

export function isUntitledPath(path: string | null | undefined): boolean {
  return typeof path === "string" && path.startsWith(UNTITLED_PATH_PREFIX);
}

// ---------------------------------------------------------------------------
// Store contract
// ---------------------------------------------------------------------------

export interface EditorStore {
  features: Record<number, EditorFeatureState>;

  initFeature: (featureId: number) => void;
  openFile: (
    featureId: number,
    paneId: string,
    filePath: string,
    maxTabs?: number,
    goToLine?: number,
  ) => void;
  /**
   * Open a new empty "untitled" scratch tab. Used by CMD+N before the
   * buffer is ever saved to disk. Returns the synthetic `untitled://…`
   * path so the caller can find the tab again — see
   * `convertUntitledToFile` for the save-as transition.
   */
  openUntitledBuffer: (featureId: number, paneId: string, maxTabs?: number) => string;
  /**
   * Replace an untitled tab with a real on-disk file tab in place — same
   * position, same paneId — after the user picks a path in the native
   * save dialog and the backend confirms the write. If a tab for
   * `newFilePath` already exists in this pane, drop the untitled and
   * activate the existing one instead.
   */
  convertUntitledToFile: (
    featureId: number,
    paneId: string,
    untitledPath: string,
    newFilePath: string,
  ) => void;
  closeTab: (featureId: number, paneId: string, filePath: string) => void;
  /**
   * Update every tab across every pane whose path equals `oldPath` or
   * lives under `oldPath/` (folder rename) so the tab points at the new
   * filesystem path. Called after the file tree confirms a rename/move
   * with the backend.
   */
  renameFilePath: (featureId: number, oldPath: string, newPath: string) => void;
  setActiveFile: (featureId: number, paneId: string, filePath: string) => void;
  setDirty: (featureId: number, paneId: string, filePath: string, isDirty: boolean) => void;
  setCursorPosition: (
    featureId: number,
    paneId: string,
    filePath: string,
    pos: { line: number; col: number },
  ) => void;
  toggleSidebar: (featureId: number) => void;
  /** Hide the file tree for an Editor opened beside the agent (not persisted). */
  hideSidebarBesideAgent: (featureId: number) => void;
  splitEditorPane: (featureId: number, paneId: string, orientation: SplitOrientation) => void;
  removeEditorPane: (featureId: number, paneId: string) => void;
  navigatePane: (featureId: number, direction: Direction) => void;
  setActivePane: (featureId: number, paneId: string) => void;
  openArtifact: (
    featureId: number,
    paneId: string,
    phaseSlug: string,
    maxTabs?: number,
    artifactType?: string,
  ) => void;
  openPhaseArtifacts: (
    featureId: number,
    paneId: string,
    phaseSlug: string,
    artifactTypes: string[],
    maxTabs?: number,
  ) => void;
  clearPendingGoToLine: (featureId: number, paneId: string, filePath: string) => void;
}

// Slice-creator signatures shared by the action modules.
export type EditorSet = StoreApi<EditorStore>["setState"];
export type EditorGet = StoreApi<EditorStore>["getState"];

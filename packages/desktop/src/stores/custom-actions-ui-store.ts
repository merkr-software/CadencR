import { create } from "zustand";

import type { CustomAction } from "@/api/generated";

/** An action about to run in one conversation. */
export interface CustomActionLaunchTarget {
  action: CustomAction;
  featureId: number;
  projectId: number;
}

/** A launch waiting on `${VAR}` values from the variables dialog. */
export interface PendingVariablesPrompt {
  target: CustomActionLaunchTarget;
  /** Stored values for this conversation, prefilled into the fields. */
  values: Record<string, string>;
}

/** A background run this client started, so its end can be announced. */
export interface TrackedRun {
  actionId: number;
  actionName: string;
  featureId: number;
}

/**
 * What the action editor is open on. `projectId` is the project the editor
 * was opened from (null from the global Settings page): it offers the
 * "this project" scope and is where a new project action lands.
 */
export interface CustomActionEditorRequest {
  action?: CustomAction;
  projectId: number | null;
  /** Scope a new action starts with. */
  defaultScope: "project" | "global";
}

interface CustomActionsUiState {
  /** The action the launcher's primary button runs, per project. */
  selectedByProject: Record<number, number>;
  /** The action the Actions tab shows, per conversation. */
  runsTabActionByFeature: Record<number, number>;
  /** `${actionId}:${featureId}` keys whose launch request is in flight. */
  starting: Record<string, true>;
  pendingVariables: PendingVariablesPrompt | null;
  trackedRuns: Record<number, TrackedRun>;
  editor: CustomActionEditorRequest | null;
  openEditor: (request: CustomActionEditorRequest) => void;
  closeEditor: () => void;
  selectAction: (projectId: number, actionId: number) => void;
  showInRunsTab: (featureId: number, actionId: number) => void;
  setStarting: (actionId: number, featureId: number, starting: boolean) => void;
  openVariablesPrompt: (prompt: PendingVariablesPrompt) => void;
  closeVariablesPrompt: () => void;
  trackRun: (runId: number, run: TrackedRun) => void;
  untrackRun: (runId: number) => TrackedRun | undefined;
}

const SELECTION_STORAGE_KEY = "cadencr.customActions.selectedByProject";

function readSelection(): Record<number, number> {
  try {
    const raw = window.localStorage.getItem(SELECTION_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    );
    return Object.fromEntries(entries.map(([key, value]) => [Number(key), value]));
  } catch {
    // A corrupt or unavailable store only loses the remembered pick; the
    // launcher falls back to the first action, which is what a new user sees.
    return {};
  }
}

function writeSelection(selection: Record<number, number>): void {
  try {
    window.localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(selection));
  } catch (error) {
    console.warn("[custom-actions] could not remember the selected action", error);
  }
}

export function startingKey(actionId: number, featureId: number): string {
  return `${actionId}:${featureId}`;
}

export const useCustomActionsUiStore = create<CustomActionsUiState>((set, get) => ({
  selectedByProject: typeof window === "undefined" ? {} : readSelection(),
  runsTabActionByFeature: {},
  starting: {},
  pendingVariables: null,
  trackedRuns: {},
  editor: null,
  openEditor: (editor) => set({ editor }),
  closeEditor: () => set({ editor: null }),
  selectAction: (projectId, actionId) => {
    if (get().selectedByProject[projectId] === actionId) return;
    const selectedByProject = { ...get().selectedByProject, [projectId]: actionId };
    writeSelection(selectedByProject);
    set({ selectedByProject });
  },
  showInRunsTab: (featureId, actionId) =>
    set((state) => ({
      runsTabActionByFeature: { ...state.runsTabActionByFeature, [featureId]: actionId },
    })),
  setStarting: (actionId, featureId, starting) =>
    set((state) => {
      const key = startingKey(actionId, featureId);
      if (starting) return { starting: { ...state.starting, [key]: true } };
      const { [key]: _removed, ...rest } = state.starting;
      return { starting: rest };
    }),
  openVariablesPrompt: (pendingVariables) => set({ pendingVariables }),
  closeVariablesPrompt: () => set({ pendingVariables: null }),
  trackRun: (runId, run) =>
    set((state) => ({ trackedRuns: { ...state.trackedRuns, [runId]: run } })),
  untrackRun: (runId) => {
    const run = get().trackedRuns[runId];
    if (!run) return undefined;
    const { [runId]: _removed, ...rest } = get().trackedRuns;
    set({ trackedRuns: rest });
    return run;
  },
}));

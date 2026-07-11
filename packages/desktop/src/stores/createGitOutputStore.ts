/** Shared per-feature streaming output lifecycle used by commit and push. */
import { create, type StoreApi, type UseBoundStore } from "zustand";

const MAX_BYTES = 100 * 1024;
const TRIM_TO = 75 * 1024;

export type GitOutputStatus = "running" | "success" | "error";
export type GitOutputOutcome = Exclude<GitOutputStatus, "running"> | null;

export interface GitOutputEntry {
  output: string;
  status: GitOutputStatus;
}

export interface GitOutputState {
  byFeature: Record<number, GitOutputEntry>;
  start(featureId: number): void;
  append(featureId: number, chunk: string): void;
  complete(featureId: number, success: boolean): void;
  fail(featureId: number, detail: string): void;
  reset(featureId: number): void;
}

function clamp(previous: string, chunk: string): string {
  const next = previous + chunk;
  if (next.length <= MAX_BYTES) return next;
  return next.slice(next.length - TRIM_TO);
}

export interface GitOutputStoreBundle {
  useStore: UseBoundStore<StoreApi<GitOutputState>>;
  selectOutput: (featureId: number) => (state: GitOutputState) => string;
  selectStatus: (featureId: number) => (state: GitOutputState) => GitOutputStatus | null;
  selectRunning: (featureId: number) => (state: GitOutputState) => boolean;
  selectOutcome: (featureId: number) => (state: GitOutputState) => GitOutputOutcome;
}

export function createGitOutputStore(): GitOutputStoreBundle {
  const useStore = create<GitOutputState>((set) => ({
    byFeature: {},
    start(featureId) {
      set((state) => {
        if (state.byFeature[featureId]?.status === "running") return state;
        return {
          byFeature: {
            ...state.byFeature,
            [featureId]: { output: "", status: "running" },
          },
        };
      });
    },
    append(featureId, chunk) {
      set((state) => {
        const entry = state.byFeature[featureId];
        if (!entry || entry.status !== "running") return state;
        return {
          byFeature: {
            ...state.byFeature,
            [featureId]: { ...entry, output: clamp(entry.output, chunk) },
          },
        };
      });
    },
    complete(featureId, success) {
      set((state) => {
        const entry = state.byFeature[featureId];
        if (!entry || entry.status !== "running") return state;
        return {
          byFeature: {
            ...state.byFeature,
            [featureId]: { ...entry, status: success ? "success" : "error" },
          },
        };
      });
    },
    fail(featureId, detail) {
      set((state) => {
        const entry = state.byFeature[featureId];
        const output = clamp(entry?.output ?? "", `\n${detail}\n`);
        return {
          byFeature: {
            ...state.byFeature,
            [featureId]: { output, status: "error" },
          },
        };
      });
    },
    reset(featureId) {
      set((state) => {
        if (!state.byFeature[featureId]) return state;
        const byFeature = { ...state.byFeature };
        delete byFeature[featureId];
        return { byFeature };
      });
    },
  }));

  const selectOutput =
    (featureId: number) =>
    (state: GitOutputState): string =>
      state.byFeature[featureId]?.output ?? "";
  const selectRunning =
    (featureId: number) =>
    (state: GitOutputState): boolean =>
      state.byFeature[featureId]?.status === "running";
  const selectStatus =
    (featureId: number) =>
    (state: GitOutputState): GitOutputStatus | null =>
      state.byFeature[featureId]?.status ?? null;
  const selectOutcome =
    (featureId: number) =>
    (state: GitOutputState): GitOutputOutcome => {
      const status = state.byFeature[featureId]?.status;
      return status === "success" || status === "error" ? status : null;
    };

  return { useStore, selectOutput, selectStatus, selectRunning, selectOutcome };
}

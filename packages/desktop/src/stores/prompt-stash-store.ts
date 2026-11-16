import { create } from "zustand";
import { z } from "zod";
import { readLocalJson, writeLocalJson } from "@/lib/local-json";

/** How many stashed drafts a project keeps (oldest drop off). */
const MAX_STASHED = 10;
const STORAGE_PREFIX = "cadencr:prompt-stash:";

const STASH_SCHEMA = z.array(z.object({ text: z.string(), stashedAt: z.number() }));

export type StashedDraft = z.infer<typeof STASH_SCHEMA>[number];

interface PromptStashStore {
  byProject: Record<number, StashedDraft[]>;
  load: (projectId: number) => StashedDraft[];
  push: (projectId: number, text: string) => void;
  remove: (projectId: number, stashedAt: number) => void;
}

function read(projectId: number): StashedDraft[] {
  return (
    readLocalJson(
      STORAGE_PREFIX + projectId,
      STASH_SCHEMA,
      "Couldn't read the stashed drafts; they were reset.",
    ) ?? []
  );
}

function write(projectId: number, drafts: StashedDraft[]): void {
  writeLocalJson(STORAGE_PREFIX + projectId, drafts, "Couldn't stash the draft");
}

/**
 * Drafts set aside with Ctrl+S, per project, newest first. Like a shell's
 * history they outlive the conversation they were written in, so a half
 * written instruction can move to the conversation it belongs to.
 */
export const usePromptStashStore = create<PromptStashStore>((set, get) => ({
  byProject: {},
  load: (projectId) => {
    const cached = get().byProject[projectId];
    if (cached) return cached;
    const drafts = read(projectId);
    set({ byProject: { ...get().byProject, [projectId]: drafts } });
    return drafts;
  },
  push: (projectId, text) => {
    const next = [{ text, stashedAt: Date.now() }, ...get().load(projectId)].slice(0, MAX_STASHED);
    write(projectId, next);
    set({ byProject: { ...get().byProject, [projectId]: next } });
  },
  remove: (projectId, stashedAt) => {
    const next = get()
      .load(projectId)
      .filter((draft) => draft.stashedAt !== stashedAt);
    write(projectId, next);
    set({ byProject: { ...get().byProject, [projectId]: next } });
  },
}));

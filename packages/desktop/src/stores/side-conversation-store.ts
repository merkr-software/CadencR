import { useEffect } from "react";
import { create } from "zustand";
import { z } from "zod";
import { readLocalJson, writeLocalJson } from "@/lib/local-json";

const STORAGE_PREFIX = "cadencr:side-conversations:";

const SIDE_CONVERSATIONS_SCHEMA = z.array(
  z.object({
    featureId: z.number(),
    sessionId: z.number(),
    projectId: z.number(),
    question: z.string(),
  }),
);

export type SideConversation = z.infer<typeof SIDE_CONVERSATIONS_SCHEMA>[number];

const NONE: readonly SideConversation[] = [];

interface SideConversationStore {
  bySource: Record<number, readonly SideConversation[]>;
  load: (sourceSessionId: number) => readonly SideConversation[];
  add: (sourceSessionId: number, conversation: SideConversation) => void;
  remove: (sourceSessionId: number, featureId: number) => void;
}

function read(sourceSessionId: number): SideConversation[] {
  return (
    readLocalJson(
      STORAGE_PREFIX + sourceSessionId,
      SIDE_CONVERSATIONS_SCHEMA,
      "Couldn't read this conversation's side questions; they were reset.",
    ) ?? []
  );
}

function write(sourceSessionId: number, conversations: readonly SideConversation[]): void {
  writeLocalJson(
    STORAGE_PREFIX + sourceSessionId,
    conversations.length > 0 ? conversations : null,
    "Couldn't remember the side question",
  );
}

/**
 * The side questions shown under a conversation (`/cadencr:side`), per source
 * session, oldest first. Each is a temporary, archived conversation the
 * service created; it stays here until the user keeps it as a thread or
 * closes it, across reloads.
 */
export const useSideConversationStore = create<SideConversationStore>((set, get) => ({
  bySource: {},
  load: (sourceSessionId) => {
    const cached = get().bySource[sourceSessionId];
    if (cached) return cached;
    const stored = read(sourceSessionId);
    // `NONE` for an empty list keeps the hook's selected value unchanged.
    const conversations = stored.length > 0 ? stored : NONE;
    set({
      bySource: { ...get().bySource, [sourceSessionId]: conversations },
    });
    return conversations;
  },
  add: (sourceSessionId, conversation) => {
    const next = [
      ...get()
        .load(sourceSessionId)
        .filter((entry) => entry.featureId !== conversation.featureId),
      conversation,
    ];
    write(sourceSessionId, next);
    set({ bySource: { ...get().bySource, [sourceSessionId]: next } });
  },
  remove: (sourceSessionId, featureId) => {
    const current = get().load(sourceSessionId);
    const next = current.filter((entry) => entry.featureId !== featureId);
    if (next.length === current.length) return;
    write(sourceSessionId, next);
    set({ bySource: { ...get().bySource, [sourceSessionId]: next } });
  },
}));

/** The side questions of a conversation, loaded from storage on first use. */
export function useSideConversations(
  sourceSessionId: number | undefined,
): readonly SideConversation[] {
  useEffect(() => {
    if (sourceSessionId != null) useSideConversationStore.getState().load(sourceSessionId);
  }, [sourceSessionId]);
  return useSideConversationStore((state) =>
    sourceSessionId == null ? NONE : (state.bySource[sourceSessionId] ?? NONE),
  );
}

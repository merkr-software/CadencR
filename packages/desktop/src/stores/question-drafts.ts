import { create } from "zustand";
import type { SessionStatusEntry } from "./session-status-store";

export interface QuestionAnswerDraft {
  text: string;
  selectedOptions: Set<string>;
  freeText: string;
  showOther: boolean;
}

export interface QuestionDraft {
  currentIndex: number;
  answers: QuestionAnswerDraft[];
  selectedOptions: Set<string>;
  freeText: string;
  showOther: boolean;
}

export interface QuestionDraftIdentity {
  sessionId: number;
  requestId: string;
}

export const EMPTY_QUESTION_DRAFT: QuestionDraft = {
  currentIndex: 0,
  answers: [],
  selectedOptions: new Set(),
  freeText: "",
  showOther: false,
};

// Renderer memory only. One gate per session; cap abandoned drafts even if the
// app socket never reconnects to deliver their closing status.
const MAX_DRAFTS = 100;
type DraftEntry = QuestionDraftIdentity & { draft: QuestionDraft };
export const useQuestionDraftStore = create<{ drafts: ReadonlyMap<number, DraftEntry> }>(() => ({
  drafts: new Map(),
}));

export function updateQuestionDraft(
  identity: QuestionDraftIdentity,
  update: (draft: QuestionDraft) => QuestionDraft,
): void {
  useQuestionDraftStore.setState((state) => {
    const { drafts } = state;
    const existing = drafts.get(identity.sessionId);
    const draft =
      existing?.requestId === identity.requestId ? existing.draft : EMPTY_QUESTION_DRAFT;
    const updated = update(draft);
    if (updated === draft) return state;
    const next = new Map(drafts);
    next.delete(identity.sessionId);
    next.set(identity.sessionId, { ...identity, draft: updated });
    if (next.size > MAX_DRAFTS) next.delete(next.keys().next().value!);
    return { drafts: next };
  });
}

export function clearQuestionDraft(sessionId: number, requestId: string): void {
  const { drafts } = useQuestionDraftStore.getState();
  if (drafts.get(sessionId)?.requestId !== requestId) return;
  const next = new Map(drafts);
  next.delete(sessionId);
  useQuestionDraftStore.setState({ drafts: next });
}

/** Only invalidate a gate the app socket has already observed. The feature
 * socket may deliver its next gate before an older app status/snapshot. */
export function reconcileQuestionDrafts(
  previous: Record<number, SessionStatusEntry>,
  statuses: Record<number, SessionStatusEntry>,
): void {
  const { drafts } = useQuestionDraftStore.getState();
  let next: Map<number, DraftEntry> | undefined;
  const matches = (status: SessionStatusEntry | undefined, entry: DraftEntry): boolean =>
    status?.status === "question" &&
    status.kind === "question" &&
    status.requestId === entry.requestId;
  for (const entry of drafts.values()) {
    if (!matches(previous[entry.sessionId], entry) || matches(statuses[entry.sessionId], entry))
      continue;
    next ??= new Map(drafts);
    next.delete(entry.sessionId);
  }
  if (next) useQuestionDraftStore.setState({ drafts: next });
}

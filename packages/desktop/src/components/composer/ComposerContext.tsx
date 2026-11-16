import { createContext, useContext, type ReactNode } from "react";
import type { ImageAttachment } from "@/hooks/useImageAttachments";
import type { SlashCommand } from "@/lib/slash-command";
import type { SessionInfoPanelProps } from "../agent-session/SessionInfoChip";
import type { ContextUsageState } from "@/types/agent";

/**
 * Imperative access to the composer's editor for the composer's satellite
 * pieces (context tray, history search, launch manifest…). Every method is a
 * no-op until the Lexical editor has mounted.
 */
export interface ComposerEditorApi {
  focus: () => void;
  getText: () => string;
  /** Replace the whole draft (persisted as a draft, never sent). */
  setText: (text: string) => void;
  /** Insert at the caret, or append when the editor has no selection. */
  insertText: (text: string) => void;
}

/**
 * Session facts every composer satellite needs. Provided once by
 * `AgentPromptBar`; read with `useComposerContext()` instead of threading
 * props through the bar. Keep it identity-stable: the bar memoizes the value.
 */
export interface ComposerContextValue {
  featureId?: number;
  projectId?: number;
  sessionId?: number;
  wsSessionId?: string;
  /** True while the agent is working. */
  isRunning: boolean;
  /** No turn has been sent yet in this conversation. */
  isFirstPrompt: boolean;
  editor: ComposerEditorApi;
  attachments: ComposerAttachmentsApi;
  contextUsage: ContextUsageState | null;
  /** The provider's commands — capability checks (e.g. is `/compact` offered?). */
  slashCommands: SlashCommand[] | undefined;
  /** Send text as the next prompt (Enter semantics: steers while running). */
  send: (text: string) => void;
  /** Session details shown from the composer's menu, when the embedder has a session. */
  sessionInfo?: SessionInfoPanelProps;
  /** Project prompt history, newest first (history search). */
  history: string[];
  /** Before the first prompt: work on this branch, in its own worktree. */
  startOnBranch?: (branch: string) => void;
}

/** The draft's file/image attachments (sent with the next prompt). */
export interface ComposerAttachmentsApi {
  items: ImageAttachment[];
  add: (files: FileList | File[]) => void;
  remove: (id: string) => void;
}

const ComposerContext = createContext<ComposerContextValue | null>(null);

export function ComposerContextProvider({
  value,
  children,
}: {
  value: ComposerContextValue;
  children: ReactNode;
}) {
  return <ComposerContext.Provider value={value}>{children}</ComposerContext.Provider>;
}

/**
 * The draft text, apart from the session facts: it changes on every
 * keystroke, so only the piece that reads it (the PR-link offer) re-renders.
 */
const ComposerDraftContext = createContext("");

export const ComposerDraftProvider = ComposerDraftContext.Provider;

export function useComposerDraftText(): string {
  return useContext(ComposerDraftContext);
}

/** Composer session facts; throws outside an `AgentPromptBar`. */
export function useComposerContext(): ComposerContextValue {
  const value = useContext(ComposerContext);
  if (!value) throw new Error("useComposerContext must be used inside AgentPromptBar");
  return value;
}

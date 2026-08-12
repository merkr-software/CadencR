import type { AgentQuestionAnswers } from "@/components/AgentQuestionDrawer";
import type { PermissionDecisionValue } from "@/components/ToolPermissionPrompt";
import type { DisplayRowMode } from "@/components/agentStreamDisplay";
import type {
  GateCloseReason,
  PromptDispatchOptions,
  SessionConfig,
  WsEnvelope,
} from "@/lib/ws-envelope";
import type { AccessMode } from "@/types/access-mode";
import type { RuntimeSessionConfigValue } from "@/api/generated";
import type {
  PermissionMode,
  PersistedStatePayload,
  ResyncTarget,
  SessionEntry,
} from "./ws-session-types";

/** A pending dirty-worktree confirmation for a rewind, surfaced as a dialog. */
export interface BranchConfirmState {
  /** Store key of the session being rewound. */
  sessionId: string;
  messageId: number;
  kind: "rewind";
  reason: string;
}

/** One-shot signal to prefill a session's composer with a rewound/forked draft. */
export interface ComposerPrefill {
  /** Store key of the session whose composer should receive the text. */
  sessionId: string;
  text: string;
  /** Bumped each time so an identical text still retriggers the effect. */
  nonce: number;
}

/**
 * One-shot signal to navigate the originating client to a freshly-forked
 * feature. The store can't navigate, so `forkFromMessage` parks the target here
 * and the source session's `AgentSession` effect performs the navigation.
 */
export interface ForkNavigation {
  /** Store key of the session that initiated the fork (only it navigates). */
  sessionId: string;
  projectId: number;
  featureId: number;
  /** Bumped each time so a repeat fork to the same feature still retriggers. */
  nonce: number;
}

export interface WsSessionStore {
  sessions: Record<string, SessionEntry>;

  /** Set while a rewind awaits the user's confirmation to discard changes. */
  branchConfirm: BranchConfirmState | null;
  /** Set to push a draft into the target session's composer, then consumed. */
  composerPrefill: ComposerPrefill | null;
  /** Set to navigate the originating client to a just-forked feature, then consumed. */
  forkNavigation: ForkNavigation | null;

  connect: (sessionId: string) => void;
  disconnect: (sessionId: string) => void;

  send: (sessionId: string, envelope: WsEnvelope) => void;
  initSession: (sessionId: string, config: SessionConfig) => void;
  sendPrompt: (sessionId: string, text: string, options?: PromptDispatchOptions) => void;
  respondToPermission: (
    sessionId: string,
    requestId: string,
    decision: PermissionDecisionValue,
    feedback?: string,
    optionId?: string,
  ) => void;
  respondToQuestion: (sessionId: string, response: AgentQuestionAnswers) => void;
  interrupt: (sessionId: string) => void;
  destroy: (sessionId: string) => void;
  clearSession: (sessionId: string) => void;
  /** Rewind conversation + code back to before `messageId`, in place. */
  rewindToMessage: (sessionId: string, messageId: number, confirmDiscard?: boolean) => void;
  /** Fork the conversation into a new session at `messageId` (same worktree). */
  forkFromMessage: (sessionId: string, messageId: number) => void;
  /** Resolve a pending `branchConfirm` (re-runs the rewind when confirmed). */
  resolveBranchConfirm: (confirmed: boolean) => void;
  /** Clear `composerPrefill` once the target composer has applied it. */
  consumeComposerPrefill: (sessionId: string) => void;
  /** Clear `forkNavigation` once the source session has navigated to the fork. */
  consumeForkNavigation: (sessionId: string) => void;
  compactSession: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  setProvider: (sessionId: string, providerId: string) => void;
  setModel: (sessionId: string, modelId: string, providerId: string) => void;
  setThinkingEffort: (sessionId: string, thinkingEffort?: string) => void;
  setFastMode: (sessionId: string, enabled: boolean) => Promise<void>;
  setProfile: (sessionId: string, profile: string) => void;
  setPermissionMode: (sessionId: string, mode: PermissionMode) => void;
  setAccessMode: (sessionId: string, mode: AccessMode) => void;
  approvePlan: (sessionId: string) => void;
  requestPlanChanges: (sessionId: string, feedback: string) => void;
  closeGate: (sessionId: string, reason: GateCloseReason) => void;
  requestSessionConfig: (sessionId: string) => Promise<void>;
  setSessionConfigOption: (
    sessionId: string,
    configId: string,
    value: RuntimeSessionConfigValue,
  ) => Promise<void>;

  sendRequest: (sessionId: string, envelope: WsEnvelope) => Promise<unknown>;

  retryWorktreeSetup: (sessionId: string) => void;
  requestSlashCommands: (sessionId: string, cwd: string, provider: string) => void;

  markPersistedLoaded: (sessionId: string) => void;
  setPersistedState: (sessionId: string, options: PersistedStatePayload) => void;
  /**
   * Loads older messages for a session. Resolves with the number of blocks
   * prepended to the conversation. The store also increments
   * `historyPrependDisplayOffset` by the rendered row count for Virtuoso.
   */
  loadOlderMessages: (sessionId: string, displayMode?: DisplayRowMode) => Promise<number>;
  /**
   * Pull any messages persisted after the newest block we hold and merge them
   * in — the same catch-up path used on WS reconnect. Used after a manual
   * "Sync from CLI" appends events to the session on the backend.
   */
  refreshSessionMessages: (sessionId: string, target?: ResyncTarget) => Promise<void>;
}

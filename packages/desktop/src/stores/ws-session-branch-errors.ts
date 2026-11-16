import { toast } from "sonner";

/**
 * How a failed rewind or fork reads. The toast leads with what happened in
 * plain words, picked from the backend's stable code; the backend's own
 * message, which names the provider's error, follows as its description.
 * Provider-neutral: no provider id or provider wording is matched here.
 */
export type BranchKind = "rewind" | "fork";

const PAST: Record<BranchKind, string> = { rewind: "rewound", fork: "forked" };

function branchFailureTitle(kind: BranchKind, code: string): string {
  const done = PAST[kind];
  switch (code) {
    case "BRANCH_SURGERY_FAILED":
      return `The conversation couldn't be ${done}. Nothing was changed.`;
    case "UNSUPPORTED_BRANCHING":
      return `This conversation can't be ${done} from this message.`;
    case "CODE_RESTORE_FAILED":
      return "The code couldn't be restored, so nothing was rewound.";
    case "NO_WORKTREE":
      return `This conversation has no working folder to be ${done} in yet.`;
    case "SESSION_NOT_FOUND":
    case "INVALID_MESSAGE":
      return `This message can't be ${done} anymore.`;
    case "DB_ERROR":
      return `The ${kind} couldn't be saved.`;
    default:
      return `The conversation couldn't be ${done}.`;
  }
}

/** Show a rewind or fork the backend refused, replacing its loading toast. */
export function showBranchFailure(
  kind: BranchKind,
  toastId: string,
  failure: { code: string; message: string },
): void {
  toast.error(branchFailureTitle(kind, failure.code), {
    id: toastId,
    description: failure.message,
  });
}

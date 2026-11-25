import { translateUi } from "@/lib/i18n/ui";
import { toast } from "sonner";
import { getProviderMetadata } from "@/lib/providers";

/**
 * How a failed rewind or fork reads. The toast leads with what happened in
 * plain words, picked from the backend's stable code; the backend's own
 * message, which names the provider's error, follows as its description.
 * Provider-neutral: no provider id or provider wording is matched here; a
 * title that names the provider takes its label from the catalog.
 */
export type BranchKind = "rewind" | "fork";

function branchFailureTitle(kind: BranchKind, code: string, providerId?: string): string {
  switch (code) {
    case "PROVIDER_CONVERSATION_MISSING": {
      const provider =
        getProviderMetadata(providerId)?.label ??
        translateUi("conversation.branch.agent", "The agent");
      return kind === "rewind"
        ? translateUi(
            "conversation.rewind.missingSource",
            "{{provider}} no longer has this conversation, so it can't be rewound.",
            { provider },
          )
        : translateUi(
            "conversation.fork.missingSource",
            "{{provider}} no longer has this conversation, so it can't be forked.",
            { provider },
          );
    }
    case "BRANCH_SURGERY_FAILED":
      return kind === "rewind"
        ? translateUi(
            "conversation.rewind.failedSafely",
            "The conversation couldn't be rewound. Nothing was changed.",
          )
        : translateUi(
            "conversation.fork.failedSafely",
            "The conversation couldn't be forked. Nothing was changed.",
          );
    case "UNSUPPORTED_BRANCHING":
      return kind === "rewind"
        ? translateUi(
            "conversation.rewind.unsupported",
            "This conversation can't be rewound from this message.",
          )
        : translateUi(
            "conversation.fork.unsupported",
            "This conversation can't be forked from this message.",
          );
    case "CODE_RESTORE_FAILED":
      return translateUi(
        "conversation.rewind.couldNotRestore",
        "The code couldn't be restored, so nothing was rewound.",
      );
    case "NO_WORKTREE":
      return kind === "rewind"
        ? translateUi(
            "conversation.rewind.missingFolder",
            "This conversation has no working folder to be rewound in yet.",
          )
        : translateUi(
            "conversation.fork.missingFolder",
            "This conversation has no working folder to be forked in yet.",
          );
    case "SESSION_NOT_FOUND":
    case "INVALID_MESSAGE":
      return kind === "rewind"
        ? translateUi(
            "conversation.rewind.invalidMessage",
            "This message can't be rewound anymore.",
          )
        : translateUi("conversation.fork.invalidMessage", "This message can't be forked anymore.");
    case "DB_ERROR":
      return kind === "rewind"
        ? translateUi("conversation.rewind.saveFailed", "The rewind couldn't be saved.")
        : translateUi("conversation.fork.saveFailed", "The fork couldn't be saved.");
    default:
      return kind === "rewind"
        ? translateUi("conversation.rewind.failed", "The conversation couldn't be rewound.")
        : translateUi("conversation.fork.failed", "The conversation couldn't be forked.");
  }
}

/** Show a rewind or fork the backend refused, replacing its loading toast. */
export function showBranchFailure(
  kind: BranchKind,
  toastId: string,
  failure: { code: string; message: string },
  providerId?: string,
): void {
  toast.error(branchFailureTitle(kind, failure.code, providerId), {
    id: toastId,
    description: failure.message,
  });
}

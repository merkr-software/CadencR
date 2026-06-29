import { memo, useCallback, useEffect, useRef, useState } from "react";
import { CopyIcon, CheckIcon, RotateCcwIcon, GitBranchIcon } from "lucide-react";
import { copyAs } from "@/lib/markdown-export";
import { parseUserMessageContent } from "@/types/agent-types";
import { cn } from "@/lib/utils";
import type { AgentBlockData } from "../AgentBlock";
import { useMessageBranchActions } from "./use-message-branch-actions";

interface UserMessageActionsProps {
  block: AgentBlockData;
}

/**
 * On-hover action row shown under a user message: Copy (markdown), Fork, and
 * Rewind. Mirrors the agent text-block copy affordance. Rendered inside the
 * `group/usermsg` hover group owned by `UserMessageBlock`.
 */
function UserMessageActionsImpl({ block }: UserMessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const { canBranch, rewind, fork } = useMessageBranchActions(block);
  // Virtuoso recycles stream rows, so a row can unmount inside the 1.5s window —
  // track the timer and clear it on unmount to avoid a dangling timeout.
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const handleCopy = useCallback(() => {
    const { text } = parseUserMessageContent(block.content);
    void copyAs("markdown", text);
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  }, [block.content]);

  return (
    <div className="mt-2 mb-2 flex items-center gap-1 opacity-0 transition-opacity group-hover/usermsg:opacity-100">
      <ActionButton onClick={handleCopy} title="Copy as Markdown">
        {copied ? (
          <>
            <CheckIcon className="size-3 text-green-400" />
            <span className="text-green-400">Copied</span>
          </>
        ) : (
          <>
            <CopyIcon className="size-3" />
            <span>Copy</span>
          </>
        )}
      </ActionButton>
      {canBranch && (
        <>
          <ActionButton onClick={fork} title="Fork a new session from this message">
            <GitBranchIcon className="size-3" />
            <span>Fork</span>
          </ActionButton>
          <ActionButton onClick={rewind} title="Rewind the session to this message">
            <RotateCcwIcon className="size-3" />
            <span>Rewind</span>
          </ActionButton>
        </>
      )}
    </div>
  );
}

function ActionButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-foreground/70",
        "transition-colors hover:bg-accent hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

export const UserMessageActions = memo(UserMessageActionsImpl);

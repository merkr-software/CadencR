/**
 * Streaming bash terminal for the commit dialog.
 *
 * Re-uses the canonical {@link BashBlock} — the same component agent
 * `Bash` tool calls render with — so the commit experience matches the
 * rest of the app pixel-for-pixel:
 *  - Zinc chrome by default; full red palette on error (no custom border).
 *  - ANSI colors / bold / dim / underline parsed via `parseAnsi`.
 *  - "Show last N / Show all" truncation toggle.
 *
 * The pane is a thin adapter: it pulls the streamed buffer + lifecycle
 * flag from `useCommitOutputStore` via narrow selectors and feeds them
 * into `BashBlock`. No layout, no error chrome of its own — those are
 * the bash block's responsibility, end of story.
 */
import { memo, type ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { BashBlock } from "@/components/BashBlock";
import {
  selectCommitOutput,
  selectCommitStatus,
  useCommitOutputStore,
} from "@/stores/useCommitOutputStore";

interface CommitOutputPaneProps {
  featureId: number;
}

export const CommitOutputPane = memo(function CommitOutputPane({
  featureId,
}: CommitOutputPaneProps): ReactElement | null {
  // Two primitive selectors isolate this feature's output and lifecycle.
  const text = useCommitOutputStore(selectCommitOutput(featureId));
  const status = useCommitOutputStore(selectCommitStatus(featureId));
  const running = status === "running";

  // Hide entirely until either the user submits or output starts flowing.
  if (!text && !running) return null;

  // Do not echo the full `git commit -m "<message>"`: reproducing a long
  // message in the header is noisy and can widen the dialog. The operation
  // name keeps the focus on the streamed hook output.
  const command = "git commit";

  // Hard invariant: the command is "in error" only once the underlying
  // process has exited. Until the WS lifecycle is `complete`, we keep the
  // block in its neutral chrome — even if streamed output already contains
  // red ANSI lines from a failing tool
  // (eslint, vitest, …). Pre-commit tools routinely emit colored progress
  // and only the final exit status decides whether the *commit* itself
  // failed; flipping the block red mid-stream would lie about that.
  const isError = status === "error";

  return (
    <BashBlock
      command={command}
      content={text}
      running={running}
      isError={isError}
      // Cap the live body height: without this the dialog would grow
      // unbounded as the buffer streams in (matters during long
      // pre-commit hook runs). `max-h-64` matches the prior design.
      bodyExtraClassName="max-h-64 overflow-y-auto"
      runningFooter={
        <div className="mt-1 flex items-center gap-1.5 border-t border-zinc-800 pt-1 text-[11px] text-zinc-500">
          <Loader2 className="size-3 animate-spin" />
          Pre-commit hooks are running — you can safely continue in the background.
        </div>
      }
    />
  );
});

import { useUiTranslation } from "@/lib/i18n/ui";
import { memo } from "react";
import { AlertTriangle, RotateCw, X } from "lucide-react";

interface TerminalCwdWarningProps {
  /** Working directory the PTY was actually spawned in (stale). */
  paneCwd: string;
  /** Working directory the feature currently expects (e.g. fresh worktree). */
  expectedCwd: string;
  /** Kill the pane and respawn a new one in the expected cwd. */
  onRestart: () => void;
  /** Hide the warning without restarting. */
  onDismiss: () => void;
}

/**
 * Banner shown above a terminal pane whose PTY was spawned in a directory that
 * no longer matches the feature's expected working directory — typically when
 * a terminal was open before the user toggled "use worktree" on the first
 * prompt, leaving the existing shell pinned to the project root.
 */
export const TerminalCwdWarning = memo(function TerminalCwdWarning({
  paneCwd,
  expectedCwd,
  onRestart,
  onDismiss,
}: TerminalCwdWarningProps) {
  const { t } = useUiTranslation();
  return (
    <div
      role="status"
      className="flex items-start gap-2 border-b border-[var(--terminal-warning-border)] bg-[var(--terminal-warning-bg)] px-3 py-1.5 text-[11px] text-[var(--terminal-warning-fg)]"
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--terminal-warning-accent)]" />
      <div className="min-w-0 flex-1 leading-tight">
        <div>
          <span className="font-medium text-[var(--terminal-warning-accent)]">
            {t(
              "workspace.tools.terminalCwdWarning.wrongWorkingDirectory",
              "Wrong working directory.",
            )}
          </span>{" "}
          {t(
            "workspace.tools.terminalCwdWarning.thisTerminalIsStillRunningInThe",
            "This terminal is still running in the project root, not the active worktree.",
          )}
        </div>
        <div
          className="mt-0.5 truncate text-[var(--terminal-warning-fg-secondary)]"
          title={`${paneCwd} → ${expectedCwd}`}
        >
          <span className="text-[var(--terminal-warning-link)]">
            {t("workspace.tools.terminalCwdWarning.now", "now:")}
          </span>{" "}
          {paneCwd}{" "}
          <span className="text-[var(--terminal-warning-link)]">
            {t("workspace.tools.terminalCwdWarning.expected", "expected:")}
          </span>{" "}
          {expectedCwd}
        </div>
      </div>
      <button
        type="button"
        onClick={onRestart}
        className="flex shrink-0 items-center gap-1 rounded bg-[var(--terminal-warning-button-bg)] px-2 py-0.5 text-[var(--terminal-warning-fg)] transition-colors hover:bg-[var(--terminal-warning-button-bg-hover)]"
      >
        <RotateCw className="size-3" />
        {t("workspace.tools.terminalCwdWarning.restartHere", "Restart here")}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("workspace.tools.terminalCwdWarning.dismissWarning", "Dismiss warning")}
        className="flex size-5 shrink-0 items-center justify-center rounded text-[var(--terminal-panel-icon)] transition-colors hover:bg-[var(--terminal-panel-icon-bg-hover)] hover:text-[var(--terminal-panel-icon-hover)]"
      >
        <X className="size-3" />
      </button>
    </div>
  );
});

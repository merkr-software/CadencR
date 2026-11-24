import { memo } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useUiTranslation } from "@/lib/i18n/ui";
import {
  dismissTerminalCompatibilityNotice,
  useTerminalCompatibilityNotice,
} from "@/components/terminal-core/terminal-compatibility-notice";

/**
 * The phone layout's form of the "compatibility terminal" toast: a line at the
 * foot of the terminal pane, above the key bar, in the pane's warning colors.
 * A top toast would cover the header and the tab bar's neighbours; this one
 * covers nothing and stays until its 44px close dismisses it on this device.
 */
export const TerminalCompatibilityNotice = memo(function TerminalCompatibilityNotice() {
  const { t } = useUiTranslation();
  const reason = useTerminalCompatibilityNotice();
  if (reason === null) return null;
  return (
    <div
      role="status"
      data-terminal-compatibility-notice
      className="flex min-h-11 shrink-0 items-center gap-2 border-t border-[var(--terminal-warning-border)] bg-[var(--terminal-warning-bg)] pl-3 text-xs text-[var(--terminal-warning-fg)]"
    >
      <AlertTriangle
        aria-hidden="true"
        className="size-3.5 shrink-0 text-[var(--terminal-warning-accent)]"
      />
      <div className="min-w-0 flex-1 py-1.5 leading-tight">
        <div className="font-medium text-[var(--terminal-warning-accent)]">
          {t(
            "workspace.tools.createTerminalEngine.usingTheCompatibilityTerminal",
            "Using the compatibility terminal",
          )}
        </div>
        <div className="truncate text-[var(--terminal-warning-fg-secondary)]" title={reason}>
          {reason}
        </div>
      </div>
      <button
        type="button"
        onClick={dismissTerminalCompatibilityNotice}
        aria-label={t(
          "workspace.tools.terminalCompatibility.dismiss",
          "Dismiss compatibility terminal notice",
        )}
        className="flex size-11 shrink-0 items-center justify-center text-[var(--terminal-panel-icon)] transition-colors hover:text-[var(--terminal-panel-icon-hover)] active:bg-[var(--terminal-panel-icon-bg-hover)]"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
});

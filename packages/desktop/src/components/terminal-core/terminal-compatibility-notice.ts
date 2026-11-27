import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { getPhoneShellSnapshot } from "@/lib/form-factor";
import { translateUi } from "@/lib/i18n/ui";

/**
 * "Using the compatibility terminal": the notice that the terminal fell back
 * from WebGPU to the xterm engine. Machines without a usable WebGPU adapter
 * (common on Linux, most phones) fall back for every pane, so it is reported
 * once per session, not on each new terminal.
 *
 * Desktop layout: a warning toast, as it always was. Phone layout: a top
 * toast would cover the header and the tabs, so the terminal pane shows it as
 * an inline notice instead (`TerminalCompatibilityNotice`), dismissed for good
 * on this device.
 */

const DISMISSED_STORAGE_KEY = "cadencr.terminalCompatibilityNoticeDismissed";
const TOAST_ID = "terminal-compatibility";

interface NoticeState {
  /** Why the WebGPU engine failed; `null` until a terminal fell back. */
  reason: string | null;
  /** Dismissed on this device (read once from storage). */
  dismissed: boolean;
}

let state: NoticeState | undefined;
const listeners = new Set<() => void>();

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_STORAGE_KEY) === "1";
  } catch {
    // Storage blocked (private mode): not remembered, so the notice shows. Its
    // dismissal then says it holds for this session only (below).
    return false;
  }
}

function current(): NoticeState {
  state ??= { reason: null, dismissed: readDismissed() };
  return state;
}

function update(next: NoticeState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** A terminal fell back to the compatibility engine; `reason` is the WebGPU failure. */
export function reportTerminalCompatibility(reason: string): void {
  const previous = current();
  if (previous.reason !== null) return;
  update({ ...previous, reason });
  if (getPhoneShellSnapshot()) return;
  toast.warning(terminalCompatibilityTitle(), { id: TOAST_ID, description: reason });
}

/** Hides the phone layout's inline notice on this device for good. */
export function dismissTerminalCompatibilityNotice(): void {
  update({ ...current(), dismissed: true });
  try {
    localStorage.setItem(DISMISSED_STORAGE_KEY, "1");
  } catch {
    // Storage blocked: dismissed for this session only (state above), and the
    // user is told it will be back.
    toast.message(
      translateUi(
        "workspace.tools.terminalCompatibility.hiddenUntilReload",
        "Hidden until the next reload",
      ),
      {
        id: TOAST_ID,
        description: translateUi(
          "workspace.tools.terminalCompatibility.dismissNotRemembered",
          "This browser does not let Cadencr remember that you dismissed it.",
        ),
      },
    );
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getReasonSnapshot(): string | null {
  const { reason, dismissed } = current();
  return dismissed ? null : reason;
}

/** The fallback's reason while the inline notice should show, else `null`. */
export function useTerminalCompatibilityNotice(): string | null {
  return useSyncExternalStore(subscribe, getReasonSnapshot, () => null);
}

/** The notice's title, in the interface language. */
export function terminalCompatibilityTitle(): string {
  return translateUi(
    "workspace.tools.createTerminalEngine.usingTheCompatibilityTerminal",
    "Using the compatibility terminal",
  );
}

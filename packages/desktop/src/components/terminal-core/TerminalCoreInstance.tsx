import { forwardRef } from "react";
import { useTerminalCoreInstanceController } from "./useTerminalCoreInstanceController";
import type {
  TerminalCoreInstanceHandle,
  TerminalCoreInstanceProps,
} from "./TerminalCoreInstance.types";

export type {
  TerminalCoreInstanceHandle,
  TerminalCoreInstanceProps,
} from "./TerminalCoreInstance.types";

export const TerminalCoreInstance = forwardRef<
  TerminalCoreInstanceHandle,
  TerminalCoreInstanceProps
>(function TerminalCoreInstance(props, ref) {
  const { hostRef, status, isLoading, error } = useTerminalCoreInstanceController(props, ref);

  return (
    <div
      ref={hostRef}
      className="relative h-full w-full"
      style={{
        backgroundColor: "var(--terminal-bg)",
        paddingLeft: 8,
        paddingRight: 8,
      }}
    >
      {/* The host stays mounted in every non-fatal state: `Terminal` needs
            an element to attach its canvas to, and gating this on `status`
            would deadlock exactly the way the Neovim pane once did — the
            engine waiting for a canvas that only mounts once the engine is
            ready. */}
      {status === "error" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-sm text-red-500">{error ?? "Terminal error"}</p>
        </div>
      )}
      {(status === "loading" || isLoading) && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        </div>
      )}
    </div>
  );
});

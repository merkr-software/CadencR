import { memo, useEffect, useRef, useState } from "react";
import { Loader2Icon } from "lucide-react";
import type { TerminalOptions } from "celeritty";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/useTheme";
import { useCelerittyTerminal } from "@/components/terminal-core";
import { useNeovimWebSocket } from "./useNeovimWebSocket";
import { useNeovimTransport } from "./useNeovimTransport";

interface NeovimPaneProps {
  featureId: number;
}

const NEOVIM_FONT = {
  family:
    "'FiraCode Nerd Font', 'Fira Code', 'CaskaydiaCove Nerd Font', 'Cascadia Code', 'SF Mono', Menlo, Monaco, 'Courier New', monospace",
  size: 13,
};

/**
 * Full-frame Neovim panel: no `EditorSubTabs`, no tab/file-tree sync — Neovim
 * owns its own buffers entirely, per the level-3 design decision. Opening a
 * file from Cadencr's sidebar goes through a control-socket command (plan 4),
 * not through this pane's own state.
 *
 * Key/mouse encoding, scrollback, selection, links and the WebGPU draw loop
 * all live inside `Terminal` (`celeritty`) now — this pane only owns the
 * socket and the transport bridge, matching `TerminalCoreInstance`'s split
 * between socket ownership (per-consumer) and terminal lifecycle (shared,
 * via `useCelerittyTerminal`).
 */
function NeovimPane({ featureId }: NeovimPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { theme } = useTheme();
  const [connected, setConnected] = useState(false);

  const socket = useNeovimWebSocket({
    featureId,
    onData: (bytes) => bridge.deliverData(bytes),
    onAttached: (bytes) => bridge.deliverData(bytes),
    onError: (message) => bridge.deliverClose(message),
  });

  const bridge = useNeovimTransport(socket);

  useEffect(() => {
    socket.connect();
    setConnected(true);
    return () => {
      socket.detach();
      setConnected(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureId]);

  const options: TerminalOptions = {
    font: NEOVIM_FONT,
    colors: theme.xterm,
    cursor: { style: "block", blink: false },
    scrollback: 10_000,
  };

  const { status, errorMessage } = useCelerittyTerminal({
    hostRef,
    options,
    transport: connected ? bridge.transport : undefined,
  });

  if (status === "error") {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 bg-background text-sm text-center px-6">
        <p className="text-destructive">Neovim could not start: {errorMessage}</p>
      </div>
    );
  }

  if (socket.lastError && status === "loading") {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 bg-background text-sm text-center px-6">
        <p className="text-destructive">Neovim could not start: {socket.lastError}</p>
      </div>
    );
  }

  // The host stays mounted in every non-fatal state: `Terminal` needs an
  // element to attach its canvas to, so gating it behind `status === "ready"`
  // would deadlock — no host, no engine, no ready. The loading state is an
  // overlay on top of the live host.
  return (
    <div className="relative h-full w-full">
      <div
        ref={hostRef}
        role="application"
        aria-label="Neovim editor"
        className="h-full w-full outline-none"
      />
      {status !== "ready" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background">
          <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Connecting to Neovim…</p>
          <RestartAction featureId={featureId} onRestart={socket.connect} />
        </div>
      )}
    </div>
  );
}

function RestartAction({ featureId, onRestart }: { featureId: number; onRestart: () => void }) {
  void featureId;
  return (
    <Button variant="outline" size="sm" onClick={onRestart}>
      Restart Neovim session
    </Button>
  );
}

export default memo(NeovimPane);

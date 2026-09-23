import { memo, useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { Loader2Icon } from "lucide-react";
import type { TerminalOptions } from "celeritty";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/useTheme";
import { useCelerittyTerminal, useTerminalOptions } from "@/components/terminal-core";
import { useMonoFont } from "@/lib/fonts/mono-font-setting";
import { useNeovimWebSocket } from "./useNeovimWebSocket";
import { useNeovimTransport } from "./useNeovimTransport";

interface NeovimPaneProps {
  featureId: number;
}

/**
 * Terminal appearance for the Neovim pane, resolved exactly like the Terminal
 * tab's (`useTerminalOptions`): the chosen Cadencr mono family, else the
 * user's alacritty.toml, else the default stack. A pane-local font list here
 * meant Neovim rendered in whatever happened to be installed, dropping Nerd
 * Font glyphs the terminal drew fine.
 *
 * A config error is only fatal while nothing ever resolved. Once the pane is
 * up the last good options are held rather than dropped: `useCelerittyTerminal`
 * keys the engine on their presence, so letting them go would dispose it, and
 * the replacement engine would start on a blank grid — the `attached` snapshot
 * that restores the screen only arrives with a (re)connection, which a config
 * error does not trigger.
 */
function useNeovimAppearance(featureId: number): {
  options: TerminalOptions | undefined;
  fatalError: string | null;
} {
  const { theme } = useTheme();
  const { family, resolved } = useMonoFont();
  const { options: terminalOptions, error } = useTerminalOptions({
    palette: theme.xterm,
    fontFamily: family ? resolved : undefined,
  });

  const resolvedOptions = useMemo<TerminalOptions | undefined>(
    () =>
      terminalOptions && {
        ...terminalOptions,
        // Only the shape Neovim starts from: it re-declares its own cursor
        // per mode through DECSCUSR as soon as it draws.
        cursor: { style: "block", blink: false },
      },
    [terminalOptions],
  );

  const lastGoodOptions = useRef(resolvedOptions);
  if (resolvedOptions) lastGoodOptions.current = resolvedOptions;
  const options = resolvedOptions ?? lastGoodOptions.current;

  useEffect(() => {
    if (!error || !options) return;
    toast.error(`Terminal configuration error: ${error}`, {
      id: `neovim-config:${featureId}`,
    });
  }, [error, options, featureId]);

  const fatalError = options ? null : error;
  return useMemo(() => ({ options, fatalError }), [options, fatalError]);
}

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

  const socket = useNeovimWebSocket({
    featureId,
    onData: (bytes) => bridge.deliverData(bytes),
    onAttached: (bytes) => bridge.deliverSnapshot(bytes),
    onError: (message) => toast.error(message, { id: `neovim:${featureId}` }),
  });

  const bridge = useNeovimTransport(socket);

  useEffect(() => {
    socket.connect();
    return () => {
      socket.detach();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureId]);

  const { options, fatalError } = useNeovimAppearance(featureId);

  const { status, errorMessage } = useCelerittyTerminal({
    hostRef,
    options,
    transport: socket.isConnected ? bridge.transport : undefined,
  });

  // Same derivation as `TerminalCoreInstance`: a configuration that never
  // resolved is fatal, not pending. Left as "loading" the pane waits for
  // options that never arrive and offers a restart that only reconnects the
  // socket.
  const paneStatus = fatalError ? "error" : status;

  useEffect(() => {
    // Fatal for the rendering, not for the session: a dead renderer ends the
    // Neovim session, a bad config does not. `detach()` unregisters the
    // reconnector, so detaching here would leave the pane disconnected with no
    // automatic `connect()` once the file is repaired. Keeping the socket
    // attached is what makes that repair recover on its own, the service
    // re-pushes the config and `useTerminalOptions` re-resolves.
    if (status === "error") socket.detach();
  }, [status, socket.detach]);

  const error = errorMessage ?? fatalError ?? socket.lastError;
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
        data-neovim-feature-id={featureId}
        className="relative h-full w-full outline-none"
      />
      {(paneStatus !== "ready" || !socket.isConnected || error) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background">
          {error ? (
            <p className="text-sm text-destructive">Neovim could not start: {error}</p>
          ) : (
            <>
              <Loader2Icon className="size-6 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Connecting to Neovim…</p>
            </>
          )}
          {paneStatus !== "error" && <RestartAction onRestart={socket.connect} />}
        </div>
      )}
    </div>
  );
}

function RestartAction({ onRestart }: { onRestart: () => void }) {
  return (
    <Button variant="outline" size="sm" onClick={onRestart}>
      Restart Neovim session
    </Button>
  );
}

export default memo(NeovimPane);

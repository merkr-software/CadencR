import type { UiTranslator } from "@/lib/i18n/ui";

/**
 * Tunnel provider guides as data. M1 ships *instructions* only (no in-process
 * tunnel SDK), so the dialog renders these generically — no per-provider
 * branches in components. `{port}` in a command is interpolated with the live
 * remote port via {@link interpolatePort}.
 *
 * The local listener serves self-signed HTTPS, so each command points the
 * tunnel at a local `https://` upstream and skips upstream cert verification
 * where the provider requires an explicit opt-in. Exact flags vary by version —
 * the docs link is authoritative.
 */
export interface TunnelGuide {
  id: string;
  name: string;
  blurb: (t: UiTranslator) => string;
  docsUrl: string;
  commands: string[];
  placeholder: string;
  /**
   * Whether this option keeps traffic private (reachable only from your own
   * devices) rather than terminating TLS on a third party. Drives the
   * "Recommended" marker generically — no per-provider branch in components.
   * Only private tunnels are shipped, so this is currently always true.
   */
  recommended?: boolean;
}

// Only private tunnels are offered. A public HTTPS tunnel terminates TLS on the
// provider's servers — exposing pairing codes, device tokens, and everything in
// the workspace — so we deliberately don't ship those options.
export const TUNNEL_GUIDES: TunnelGuide[] = [
  {
    id: "tailscale",
    name: "Tailscale",
    blurb: (t) =>
      t(
        "remote.tunnel.tailscale.description",
        "Reachable only from your own devices on your tailnet — no public exposure.",
      ),
    docsUrl: "https://tailscale.com/kb/1242/tailscale-serve",
    commands: ["tailscale serve --bg https+insecure://localhost:{port}"],
    placeholder: "your-machine.tailnet.ts.net",
    recommended: true,
  },
];

/** Replace `{port}` placeholders in a command with the live remote port. */
export function interpolatePort(command: string, port: number): string {
  return command.replaceAll("{port}", String(port));
}

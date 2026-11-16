import { useEffect, useState, type ReactElement } from "react";
import { ExternalLink } from "lucide-react";
import type { RemoteStatus } from "@/api/generated";
import { RecommendedTag } from "@/components/RecommendedTag";
import { desktopBridge } from "@/lib/desktop-bridge";
import { useRemoteStore } from "@/stores/remote-store";
import { interpolatePort, TUNNEL_GUIDES, type TunnelGuide } from "@/lib/remote/tunnel-guides";
import { CopyIconButton } from "./remote-ui";

/**
 * Optional internet exposure via a private tunnel (Tailscale). Renders the
 * guides as data and a hostname input — pasting the tunnel's hostname adds it to
 * the backend's Host allowlist (without it, tunneled requests are 421'd) and
 * makes the pairing QR/link default to that hostname.
 */
export function RemoteTunnelSection({ status }: { status: RemoteStatus }): ReactElement {
  const port = status.port ?? 0;
  return (
    <section className="space-y-2">
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Run a private tunnel, then paste its hostname below so requests through it are allowed and
        the pairing code points at it.
      </p>

      {TUNNEL_GUIDES.map((guide) => (
        <TunnelGuideCard key={guide.id} guide={guide} port={port} />
      ))}

      <TunnelHostField status={status} />
    </section>
  );
}

function TunnelGuideCard({ guide, port }: { guide: TunnelGuide; port: number }): ReactElement {
  return (
    <div className="rounded border border-border bg-card px-2.5 py-2">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          {guide.name}
          {guide.recommended ? <RecommendedTag /> : null}
        </span>
        <button
          type="button"
          onClick={() => void desktopBridge.openExternal(guide.docsUrl)}
          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Docs <ExternalLink className="size-3" aria-hidden />
        </button>
      </div>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{guide.blurb}</p>
      {guide.commands.map((template) => {
        const command = interpolatePort(template, port);
        return (
          <div
            key={template}
            className="mt-1 flex items-center justify-between gap-2 rounded bg-muted/50 px-2 py-1"
          >
            <code className="truncate font-mono text-[11px]">{command}</code>
            <CopyIconButton value={command} successLabel="Command copied" />
          </div>
        );
      })}
    </div>
  );
}

function TunnelHostField({ status }: { status: RemoteStatus }): ReactElement {
  const setTunnelHost = useRemoteStore((s) => s.setTunnelHost);
  const phase = useRemoteStore((s) => s.phase);
  const [hostInput, setHostInput] = useState(status.tunnel_host ?? "");
  // The backend normalizes the host on save (strips scheme/path, lowercases), so
  // resync the field to the committed value — otherwise the original input stays
  // and the field reads as still-dirty with Save enabled.
  useEffect(() => {
    setHostInput(status.tunnel_host ?? "");
  }, [status.tunnel_host]);
  const busy = phase === "mutating";
  const dirty = hostInput.trim() !== (status.tunnel_host ?? "");

  return (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-muted-foreground" htmlFor="remote-tunnel-host">
        Tunnel hostname
      </label>
      <div className="flex items-center gap-2">
        <input
          id="remote-tunnel-host"
          type="text"
          value={hostInput}
          onChange={(e) => setHostInput(e.target.value)}
          placeholder={TUNNEL_GUIDES[0]?.placeholder}
          className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 font-mono text-[11px] outline-none focus:border-primary"
        />
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={() => void setTunnelHost(hostInput.trim() || null)}
          className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Save
        </button>
        {status.tunnel_host ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setHostInput("");
              void setTunnelHost(null);
            }}
            className="shrink-0 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}

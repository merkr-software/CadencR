import {
  createContext,
  memo,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { SearchIcon } from "lucide-react";
import { Virtuoso } from "react-virtuoso";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { McpServerStatus } from "@/stores/ws-session-types";

interface McpServersRowProps {
  servers: McpServerStatus[] | null;
  /** Why the runtime could not report its servers; the list is then unknown. */
  error?: string | null;
}

interface McpServersReport {
  servers: McpServerStatus[] | null;
  error: string | null;
}
const McpServersContext = createContext<McpServersReport>({ servers: null, error: null });

/** The session's MCP servers, for the session info panel rendered deep below. */
export function SessionInfoMcpServersProvider({
  mcpServers,
  error = null,
  children,
}: {
  mcpServers: McpServerStatus[] | null;
  /** Why the runtime could not report its MCP servers. */
  error?: string | null;
  children: ReactNode;
}): ReactElement {
  const report = useMemo(() => ({ servers: mcpServers, error }), [mcpServers, error]);
  return <McpServersContext.Provider value={report}>{children}</McpServersContext.Provider>;
}

export function useMcpServersReport(): McpServersReport {
  return useContext(McpServersContext);
}

const MCP_SERVER_ROW_HEIGHT = 32;
const MCP_SERVER_LIST_MAX_HEIGHT = 160;

export function McpServersRow({ servers, error = null }: McpServersRowProps): ReactElement {
  const [query, setQuery] = useState("");
  const filteredServers = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const reportedServers = servers ?? [];
    if (!needle) return reportedServers;
    return reportedServers.filter((server) => server.name.toLowerCase().includes(needle));
  }, [query, servers]);

  return (
    <div className="flex min-h-0 flex-col gap-1.5 overflow-hidden">
      <div className="shrink-0 text-[11px] font-medium text-muted-foreground">MCP servers</div>
      {error !== null && (
        <p role="alert" className="text-[11px] text-destructive">
          {error}
        </p>
      )}
      {error === null && servers === null && (
        <p className="text-[11px] text-muted-foreground">MCPs not reported yet</p>
      )}
      {error === null && servers !== null && servers.length === 0 && (
        <p className="text-[11px] text-muted-foreground">No MCP servers reported</p>
      )}
      {servers !== null && servers.length > 0 && (
        <>
          <div className="relative shrink-0">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search MCP servers…"
              aria-label="Search MCP servers"
              className="h-8 pl-8 text-xs"
            />
          </div>
          {filteredServers.length > 0 ? (
            <McpServerList servers={filteredServers} />
          ) : (
            <p className="text-[11px] text-muted-foreground">
              No MCP servers match “{query.trim()}”.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function McpServerList({ servers }: { servers: McpServerStatus[] }): ReactElement {
  const height = Math.min(servers.length * MCP_SERVER_ROW_HEIGHT, MCP_SERVER_LIST_MAX_HEIGHT);
  return (
    <div
      role="list"
      aria-label="MCP servers"
      className="min-h-0 max-h-40 shrink overflow-hidden"
      style={{ height }}
    >
      <Virtuoso
        className="h-full overscroll-contain pr-1"
        data={servers}
        computeItemKey={mcpServerKey}
        itemContent={renderMcpServer}
      />
    </div>
  );
}

function mcpServerKey(_index: number, server: McpServerStatus): string {
  return server.name;
}

function renderMcpServer(_index: number, server: McpServerStatus): ReactElement {
  return <McpServerRow server={server} />;
}

const McpServerRow = memo(function McpServerRow({
  server,
}: {
  server: McpServerStatus;
}): ReactElement {
  return (
    <div
      role="listitem"
      className="mb-1 flex items-center justify-between gap-2 rounded bg-muted/40 px-2 py-1"
    >
      <span className="truncate font-mono text-[11px]">{server.name}</span>
      <Badge
        variant="ghost"
        className={cn("px-1.5 text-[10px] capitalize", mcpStatusClass(server.status))}
      >
        {server.status}
      </Badge>
    </div>
  );
});

function mcpStatusClass(status: string): string {
  switch (status.toLowerCase()) {
    case "connected":
    case "ready":
      return "bg-[color:var(--acc-green)]/15 text-[color:var(--acc-green)]";
    case "unavailable":
    case "failed":
    case "error":
      return "bg-destructive/15 text-destructive";
    default:
      return "bg-muted text-muted-foreground";
  }
}

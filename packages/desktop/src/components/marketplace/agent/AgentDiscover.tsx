import { useMemo } from "react";
import { Loader2, SearchX } from "lucide-react";
import { VirtuosoGrid } from "react-virtuoso";
import type { ExtensionCliSummary } from "@/api/generated";
import {
  useInstalledMcpServers,
  useMcpRegistrySearch,
  useSkillPages,
} from "@/hooks/useAgentExtensions";
import {
  mcpClis,
  mcpListingsByRegistryName,
  skillClis,
  type AgentExtensionKind,
} from "@/lib/agent-extensions";
import { GridList, SHELF_SIZE, ShelfFrame, TileGridSkeleton } from "../MarketplaceGrid";
import { MarketplaceEmpty, TILE_GRID } from "../MarketplaceStates";
import { AgentLoadError, CliErrors, NoCapableCli } from "./AgentStates";
import { McpTile, SkillTile } from "./AgentTiles";

interface GridContext {
  loading: boolean;
}

/** The grid's footer reads the next-page state from Virtuoso's context. */
function MoreFooter({ context }: { context?: GridContext }): React.JSX.Element | null {
  return context?.loading ? (
    <div
      role="status"
      className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground"
    >
      <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
      Loading more…
    </div>
  ) : null;
}

const GRID_COMPONENTS = { List: GridList, Footer: MoreFooter };

/** Every skill pack the CLIs' marketplaces offer, most installed first. */
export function SkillBrowse({
  query,
  clis,
  scrollParent,
  limit,
}: {
  query: string;
  clis: ExtensionCliSummary[];
  scrollParent: HTMLElement | null;
  /** Shelf mode: only the first tiles, no scrolling grid. */
  limit?: number;
}): React.JSX.Element {
  const capable = useMemo(() => skillClis(clis).filter((cli) => cli.installed), [clis]);
  const pages = useSkillPages(query, "all", capable.length > 0);
  const context = useMemo(
    () => ({ loading: pages.isFetchingNextPage }),
    [pages.isFetchingNextPage],
  );
  const skills = useMemo(
    () => pages.data?.pages.flatMap((page) => page.skills) ?? [],
    [pages.data],
  );
  if (!capable.length) return <NoCapableCli what="skills" />;
  if (pages.isPending) return <TileGridSkeleton />;
  if (pages.isError)
    return (
      <AgentLoadError
        error={pages.error}
        what="the skill marketplaces"
        retrying={pages.isFetching}
        onRetry={() => void pages.refetch()}
      />
    );
  const errors = pages.data.pages[0]?.errors;
  if (!skills.length)
    return (
      <div className="space-y-3">
        <CliErrors errors={errors} clis={clis} />
        <MarketplaceEmpty
          icon={SearchX}
          title="No skill matches"
          detail="Try another name or word."
        />
      </div>
    );
  if (limit)
    return (
      <div className={TILE_GRID}>
        {skills.slice(0, limit).map((listing) => (
          <SkillTile key={listing.key} listing={listing} clis={capable} />
        ))}
      </div>
    );
  return (
    <div className="space-y-3">
      <CliErrors errors={errors} clis={clis} />
      {scrollParent && (
        <VirtuosoGrid
          data={skills}
          customScrollParent={scrollParent}
          components={GRID_COMPONENTS}
          context={context}
          computeItemKey={(_, listing) => listing.key}
          endReached={() => {
            if (pages.hasNextPage && !pages.isFetchingNextPage) void pages.fetchNextPage();
          }}
          itemContent={(_, listing) => <SkillTile listing={listing} clis={capable} />}
        />
      )}
    </div>
  );
}

/** The official MCP Registry, searched by name, with installed state per server. */
export function McpBrowse({
  query,
  clis,
  scrollParent,
  limit,
}: {
  query: string;
  clis: ExtensionCliSummary[];
  scrollParent: HTMLElement | null;
  limit?: number;
}): React.JSX.Element {
  const capable = useMemo(() => mcpClis(clis).filter((cli) => cli.installed), [clis]);
  const search = useMcpRegistrySearch(query.trim(), capable.length > 0);
  const installed = useInstalledMcpServers(capable.length > 0);
  const context = useMemo(
    () => ({ loading: search.isFetchingNextPage }),
    [search.isFetchingNextPage],
  );
  const byName = useMemo(
    () => mcpListingsByRegistryName(installed.data?.listings ?? []),
    [installed.data],
  );
  const servers = useMemo(
    () => search.data?.pages.flatMap((page) => page.servers) ?? [],
    [search.data],
  );
  if (!capable.length) return <NoCapableCli what="MCP servers" />;
  if (search.isPending) return <TileGridSkeleton />;
  if (search.isError)
    return (
      <AgentLoadError
        error={search.error}
        what="the MCP Registry"
        retrying={search.isFetching}
        onRetry={() => void search.refetch()}
      />
    );
  if (!servers.length)
    return (
      <MarketplaceEmpty
        icon={SearchX}
        title="No server in the MCP Registry matches"
        detail="The registry searches server names, e.g. github or postgres."
      />
    );
  if (limit)
    return (
      <div className={TILE_GRID}>
        {servers.slice(0, limit).map((server) => (
          <McpTile
            key={server.name}
            server={server}
            listing={byName.get(server.name)}
            clis={capable}
          />
        ))}
      </div>
    );
  return scrollParent ? (
    <VirtuosoGrid
      data={servers}
      customScrollParent={scrollParent}
      components={GRID_COMPONENTS}
      context={context}
      computeItemKey={(_, server) => server.name}
      endReached={() => {
        if (search.hasNextPage && !search.isFetchingNextPage) void search.fetchNextPage();
      }}
      itemContent={(_, server) => (
        <McpTile server={server} listing={byName.get(server.name)} clis={capable} />
      )}
    />
  ) : (
    <div />
  );
}

/** The two agent shelves under Cadencr's own plugin shelves on Discover. */
export function AgentShelves({
  clis,
  query,
  onKindChange,
}: {
  clis: ExtensionCliSummary[];
  query: string;
  onKindChange: (kind: AgentExtensionKind) => void;
}): React.JSX.Element {
  return (
    <>
      {(["skill", "mcp"] as const).map((kind) => (
        <ShelfFrame key={kind} kind={kind} seeAll="See all" onSeeAll={() => onKindChange(kind)}>
          {kind === "skill" ? (
            <SkillBrowse query={query} clis={clis} scrollParent={null} limit={SHELF_SIZE} />
          ) : (
            <McpBrowse query={query} clis={clis} scrollParent={null} limit={SHELF_SIZE} />
          )}
        </ShelfFrame>
      ))}
    </>
  );
}

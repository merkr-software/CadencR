import { memo, useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Loader2, PackageOpen } from "lucide-react";
import { Virtuoso } from "react-virtuoso";
import type {
  ExtensionCliSummary,
  InstalledSkill,
  McpInstallation,
  McpListing,
  SkillListing,
} from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  INSTALLED_SKILLS_PARAMS,
  useExtensionClis,
  useInstalledMcpServers,
  useSkillCatalog,
} from "@/hooks/useAgentExtensions";
import {
  cliLabel,
  matchesMcpListing,
  skillIsChangeable,
  matchesSkillListing,
  mcpUpdates,
  skillUpdates,
  type AgentExtensionKind,
} from "@/lib/agent-extensions";
import { ProviderIcon } from "@/lib/provider-icons";
import { sidebarFilterTerms } from "@/lib/sidebar-filter";
import { cn } from "@/lib/utils";
import { KINDS } from "../kinds";
import { MarketplaceEmpty } from "../MarketplaceStates";
import { KindChips } from "../PluginBits";
import { useAgentExtensionActions, type AgentExtensionAction } from "./AgentExtensionActions";
import { AgentMark } from "./AgentBits";
import { AgentLoadError, CliErrors } from "./AgentStates";
import { ActionButton } from "./CliRow";
import { mcpRouteId } from "./AgentTiles";

type Row =
  | { kind: "mcp"; key: string; listing: McpListing }
  | { kind: "skill"; key: string; listing: SkillListing };

/** One installation in one CLI: where it lives, its version and its update. */
function CarrierLine({
  providerId,
  label,
  identity,
  version,
  update,
  blocked,
  action,
}: {
  providerId: string;
  label: string;
  identity: string;
  version?: string | null;
  update?: string | null;
  /** Why Cadencr cannot apply `update` itself. */
  blocked?: string | null;
  action?: AgentExtensionAction;
}): React.JSX.Element {
  return (
    <div className="flex min-h-7 items-center gap-2 text-[11.5px] text-muted-foreground">
      <ProviderIcon providerId={providerId} alt="" className="size-3.5 shrink-0" />
      <span className="shrink-0 text-foreground/85">{label}</span>
      <span className="min-w-0 truncate font-mono text-[10.5px]">
        {identity}
        {version && ` · ${version}`}
        {update && <span className="text-primary"> → {update}</span>}
      </span>
      {action && (
        <ActionButton
          action={action}
          size="xs"
          className="ml-auto shrink-0"
          idle={`Update to ${update}`}
          busyLabel="Updating…"
        />
      )}
      {update && blocked && (
        <span title={blocked} className="ml-auto shrink-0">
          Update in {label}&apos;s config
        </span>
      )}
    </div>
  );
}

function mcpUpdateAction(
  listing: McpListing,
  installation: McpInstallation,
  clis: ExtensionCliSummary[],
) {
  if (!installation.update || installation.update_blocked) return undefined;
  return {
    kind: "mcp-update",
    label: listing.name,
    cliLabel: cliLabel(clis, installation.provider_id),
    providerId: installation.provider_id,
    serverName: installation.server.name,
  } satisfies AgentExtensionAction;
}

function skillUpdateAction(skill: InstalledSkill, clis: ExtensionCliSummary[]) {
  const cli = clis.find((item) => item.provider_id === skill.provider_id);
  if (!skill.update || !cli?.support.skill_update || !skillIsChangeable(skill)) return undefined;
  return {
    kind: "skill-update",
    label: skill.name,
    cliLabel: cli.label,
    providerId: skill.provider_id,
    pluginId: skill.id,
  } satisfies AgentExtensionAction;
}

/** Every update action a row (or a whole list) can run. */
function rowUpdates(row: Row, clis: ExtensionCliSummary[]): AgentExtensionAction[] {
  return row.kind === "mcp"
    ? mcpUpdates(row.listing).flatMap(
        (installation) => mcpUpdateAction(row.listing, installation, clis) ?? [],
      )
    : skillUpdates(row.listing).flatMap((skill) => skillUpdateAction(skill, clis) ?? []);
}

const LibraryRow = memo(function LibraryRow({
  row,
  clis,
  updatesOnly,
}: {
  row: Row;
  clis: ExtensionCliSummary[];
  updatesOnly: boolean;
}): React.JSX.Element {
  const id =
    row.kind === "mcp"
      ? mcpRouteId(
          row.listing.registry?.name,
          row.listing.installations[0]?.server.name ?? row.listing.name,
        )
      : row.listing.key;
  return (
    <div
      className={cn(
        "flex gap-3 border-b border-border/70 px-4 py-3 last:border-b-0",
        KINDS[row.kind].tone,
      )}
    >
      <AgentMark kind={row.kind} name={row.listing.name} size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to="/marketplace/$kind/$id"
            params={{ kind: row.kind, id }}
            className="truncate text-[13.5px] font-semibold hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {row.listing.name}
          </Link>
          <KindChips kinds={[row.kind]} />
        </div>
        <div className="mt-1 space-y-0.5">
          {row.kind === "mcp"
            ? row.listing.installations
                .filter((installation) => !updatesOnly || installation.update)
                .map((installation) => (
                  <CarrierLine
                    key={`${installation.provider_id}:${installation.server.name}`}
                    providerId={installation.provider_id}
                    label={cliLabel(clis, installation.provider_id)}
                    identity={installation.server.name}
                    version={
                      installation.package?.version ??
                      (installation.package ? "newest each run" : null)
                    }
                    update={installation.update}
                    blocked={installation.update_blocked}
                    action={mcpUpdateAction(row.listing, installation, clis)}
                  />
                ))
            : row.listing.installed
                .filter((skill) => !updatesOnly || skill.update)
                .map((skill) => (
                  <CarrierLine
                    key={`${skill.provider_id}:${skill.id}`}
                    providerId={skill.provider_id}
                    label={cliLabel(clis, skill.provider_id)}
                    identity={skill.source === "local" ? "local folder" : skill.id}
                    version={skill.version}
                    update={skill.update}
                    action={skillUpdateAction(skill, clis)}
                  />
                ))}
        </div>
      </div>
      <Button asChild variant="ghost" size="icon-sm" className="shrink-0 self-center">
        <Link
          to="/marketplace/$kind/$id"
          params={{ kind: row.kind, id }}
          tabIndex={-1}
          aria-hidden="true"
        >
          <ChevronRight />
        </Link>
      </Button>
    </div>
  );
});

/** Installed and Updates for what lives in the agent CLIs: one row per skill or server. */
export function AgentLibrary({
  view,
  kinds,
  query,
  scrollParent,
}: {
  view: "installed" | "updates";
  kinds: readonly AgentExtensionKind[];
  query: string;
  scrollParent: HTMLElement | null;
}): React.JSX.Element {
  const clis = useExtensionClis();
  const wantsMcp = kinds.includes("mcp");
  const wantsSkills = kinds.includes("skill");
  const mcp = useInstalledMcpServers(wantsMcp);
  const skills = useSkillCatalog(INSTALLED_SKILLS_PARAMS, wantsSkills);
  const cliList = useMemo(() => clis.data?.clis ?? [], [clis.data]);
  const rows = useMemo(() => {
    const terms = sidebarFilterTerms(query);
    const mcpRows: Row[] = (wantsMcp ? (mcp.data?.listings ?? []) : [])
      .filter((listing) => view === "installed" || mcpUpdates(listing).length > 0)
      .filter((listing) => matchesMcpListing(listing, terms))
      .map((listing) => ({ kind: "mcp", key: listing.key, listing }));
    const skillRows: Row[] = (wantsSkills ? (skills.data?.skills ?? []) : [])
      .filter((listing) => view === "installed" || skillUpdates(listing).length > 0)
      .filter((listing) => matchesSkillListing(listing, terms))
      .map((listing) => ({ kind: "skill", key: `skill:${listing.key}`, listing }));
    return [...skillRows, ...mcpRows];
  }, [mcp.data, skills.data, query, view, wantsMcp, wantsSkills]);
  const failures = [
    wantsMcp && mcp.isError ? mcp : null,
    wantsSkills && skills.isError ? skills : null,
  ].filter((item) => item !== null);
  const loading =
    (wantsMcp && mcp.isPending) || (wantsSkills && skills.isPending) || clis.isPending;
  return (
    <div className="space-y-3">
      <CliErrors
        errors={[...(mcp.data?.errors ?? []), ...(skills.data?.errors ?? [])]}
        clis={cliList}
      />
      {failures.map((failure, index) => (
        <AgentLoadError
          key={index}
          error={failure.error}
          what="what the agent CLIs have installed"
          retrying={failure.isFetching}
          onRetry={() => void failure.refetch()}
        />
      ))}
      {loading ? (
        <Skeleton
          role="status"
          aria-label="Asking the agent CLIs"
          className="h-32 w-full rounded-xl"
        />
      ) : rows.length === 0 ? (
        failures.length === 0 && <LibraryEmpty view={view} searching={!!query.trim()} />
      ) : (
        <>
          {view === "updates" && <UpdateAllBar rows={rows} clis={cliList} />}
          <div className="overflow-hidden rounded-xl border border-border/80 bg-card">
            {scrollParent && (
              <Virtuoso
                data={rows}
                customScrollParent={scrollParent}
                computeItemKey={(_, row) => row.key}
                itemContent={(_, row) => (
                  <LibraryRow row={row} clis={cliList} updatesOnly={view === "updates"} />
                )}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

function LibraryEmpty({
  view,
  searching,
}: {
  view: "installed" | "updates";
  searching: boolean;
}): React.JSX.Element {
  if (searching)
    return (
      <MarketplaceEmpty icon={PackageOpen} title="Nothing in your agent CLIs matches your search" />
    );
  return view === "updates" ? (
    <MarketplaceEmpty
      icon={PackageOpen}
      title="No skill or MCP server update found"
      detail="MCP servers are checked against the MCP Registry when they pin a version; skill packs against the marketplaces each CLI keeps. Servers that run the newest package on every launch never need one."
    />
  ) : (
    <MarketplaceEmpty
      icon={PackageOpen}
      title="No skill or MCP server in your agent CLIs yet"
      detail="Install one from Discover; it is added with the CLI's own command, so it works in the terminal too."
    />
  );
}

/** Runs every update in turn and stops at the first the CLI refuses. */
function UpdateAllBar({
  rows,
  clis,
}: {
  rows: Row[];
  clis: ExtensionCliSummary[];
}): React.JSX.Element | null {
  const { runAll, runningAll: running, pending } = useAgentExtensionActions();
  const actions = useMemo(() => rows.flatMap((row) => rowUpdates(row, clis)), [rows, clis]);
  if (actions.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">
        {actions.length} updates available in your agent CLIs. Each one runs the CLI's own command.
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={running || pending.size > 0}
        onClick={() => void runAll(actions)}
      >
        {running && <Loader2 aria-hidden="true" className="animate-spin" />}
        {running ? "Updating…" : `Update all ${actions.length}`}
      </Button>
    </div>
  );
}

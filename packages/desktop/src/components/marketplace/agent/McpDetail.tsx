import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Loader2, PackageX } from "lucide-react";
import type {
  ExtensionCliSummary,
  McpInstallation,
  McpListing,
  McpRegistryServer,
} from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useExtensionClis,
  useInstalledMcpServers,
  useMcpRegistryServer,
} from "@/hooks/useAgentExtensions";
import {
  defaultServerName,
  mcpClis,
  mcpTitle,
  mcpUpdateVersion,
  optionUnsupportedReason,
} from "@/lib/agent-extensions";
import { KINDS } from "../kinds";
import { MarketplaceEmpty } from "../MarketplaceStates";
import { DetailPage } from "../PluginDetail";
import { formatDay, KindChips } from "../PluginBits";
import { ExternalLinkValue, DetailsSection, Section } from "../PluginDetailSections";
import { AgentMark, AgentStateBadge } from "./AgentBits";
import { AgentLoadError, CliErrors } from "./AgentStates";
import { ActionButton, CliRow, RemoveButton } from "./CliRow";
import { McpValuesForm, missingInputs, OptionPicker, SERVER_NAME_PATTERN } from "./McpInstallForm";

/** One MCP server: the registry entry, how it runs, and where it is installed. */
export function McpDetail({ id }: { id: string }): React.JSX.Element {
  const local = id.startsWith("local:");
  const server = useMcpRegistryServer(id, !local);
  const installed = useInstalledMcpServers();
  const clis = useExtensionClis();
  const listing = installed.data?.listings.find((item) =>
    local ? item.key === id : item.registry?.name === id,
  );
  const name = server.data ? mcpTitle(server.data) : (listing?.name ?? id.replace(/^local:/, ""));
  // Registry text shows at once; only the CLI rows wait for `mcp list`.
  const loading = (!local && server.isPending) || (local && installed.isPending) || clis.isPending;
  return (
    <DetailPage kind="mcp" name={name} className={KINDS.mcp.tone}>
      <CliErrors errors={installed.data?.errors} clis={clis.data?.clis ?? []} />
      {loading ? (
        <Skeleton
          role="status"
          aria-label="Loading the server"
          className="h-[320px] w-full rounded-xl"
        />
      ) : server.isError && !listing ? (
        <AgentLoadError
          error={server.error}
          what="this server from the MCP Registry"
          retrying={server.isFetching}
          onRetry={() => void server.refetch()}
        />
      ) : server.data || listing ? (
        <McpDetailBody
          name={name}
          server={server.data ?? listing?.registry ?? null}
          listing={listing}
          clis={clis.data?.clis ?? []}
          inventoryLoading={installed.isPending}
        />
      ) : (
        <MarketplaceEmpty
          icon={PackageX}
          title="This server is not in the MCP Registry or installed"
          action={
            <Button asChild size="sm" variant="outline">
              <Link to="/marketplace" search={{ kind: "mcp" }}>
                Back to MCP servers
              </Link>
            </Button>
          }
        />
      )}
    </DetailPage>
  );
}

function McpDetailBody({
  name,
  server,
  listing,
  clis,
  inventoryLoading,
}: {
  name: string;
  server: McpRegistryServer | null;
  listing?: McpListing;
  clis: ExtensionCliSummary[];
  inventoryLoading: boolean;
}): React.JSX.Element {
  const carriers = new Set(listing?.installations.map((item) => item.provider_id));
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-8">
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <AgentMark kind="mcp" name={name} size={64} />
            <div className="min-w-0 space-y-1">
              <h1 className="text-[26px] font-bold leading-tight tracking-[-0.015em]">{name}</h1>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {server ? `${server.name} · v${server.version}` : "Added outside the MCP Registry"}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <KindChips kinds={["mcp"]} />
            <AgentStateBadge
              installedIn={carriers.size}
              update={listing ? mcpUpdateVersion(listing) : undefined}
            />
          </div>
          <p className="max-w-[62ch] text-[14.5px] leading-[1.6] text-foreground/90">
            {server?.description ||
              "This server was added to an agent CLI directly; the MCP Registry has no entry for it."}
          </p>
        </div>
        {inventoryLoading ? (
          <Section title="Your agent CLIs">
            <div
              role="status"
              className="flex items-center gap-2 rounded-xl border border-border/80 bg-card px-4 py-4 text-[12.5px] text-muted-foreground"
            >
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              Asking each agent CLI which MCP servers it has…
            </div>
          </Section>
        ) : (
          <McpInstallSection server={server} listing={listing} clis={mcpClis(clis)} />
        )}
      </div>
      <aside className="min-w-0 space-y-8">
        {server && <McpFacts server={server} />}
        <Section title="How this works">
          <p className="text-[12.5px] leading-[1.55] text-muted-foreground">
            Cadencr runs each CLI's own <code>mcp add</code>, <code>mcp remove</code> and{" "}
            <code>mcp list</code> commands. The server then works in that CLI everywhere, terminal
            included, and the CLI starts it, not Cadencr. Registry entries are published by their
            authors and not reviewed by Cadencr: check the source before adding one.
          </p>
        </Section>
      </aside>
    </div>
  );
}

function McpFacts({ server }: { server: McpRegistryServer }): React.JSX.Element {
  const facts: [string, React.ReactNode][] = [
    ["Registry name", <span className="break-all font-mono text-[11.5px]">{server.name}</span>],
    ["Version", <span className="font-mono text-[11.5px]">{server.version}</span>],
  ];
  if (server.published_at) facts.push(["Published", formatDay(server.published_at)]);
  if (server.updated_at && server.updated_at !== server.published_at)
    facts.push(["Updated", formatDay(server.updated_at)]);
  if (server.repository) facts.push(["Source", <ExternalLinkValue url={server.repository} />]);
  if (server.website) facts.push(["Website", <ExternalLinkValue url={server.website} />]);
  facts.push(["Listed by", <ExternalLinkValue url="https://registry.modelcontextprotocol.io" />]);
  return <DetailsSection facts={facts} />;
}

function installationSummary(installation: McpInstallation): string {
  const { server, package: pkg } = installation;
  const where = server.url ?? [server.command, ...server.args].filter(Boolean).join(" ");
  const version = pkg?.version
    ? ` · ${pkg.version}`
    : pkg
      ? " · newest package on each launch"
      : "";
  return `${server.name}${version} — ${where}`;
}

function McpInstallSection({
  server,
  listing,
  clis,
}: {
  server: McpRegistryServer | null;
  listing?: McpListing;
  clis: ExtensionCliSummary[];
}): React.JSX.Element {
  const [optionIndex, setOptionIndex] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [serverName, setServerName] = useState(() =>
    server ? defaultServerName(server.name) : "",
  );
  const option = server?.options[optionIndex];
  const missing = useMemo(() => (option ? missingInputs(option, values) : []), [option, values]);
  const label = server ? mcpTitle(server) : (listing?.name ?? "");
  const ready = !!option && missing.length === 0 && SERVER_NAME_PATTERN.test(serverName);
  // The form only matters while some CLI can still take one of the options.
  const installable = clis.some(
    (cli) =>
      !listing?.installations.some((item) => item.provider_id === cli.provider_id) &&
      (server?.options ?? []).some((candidate) => !optionUnsupportedReason(cli, candidate)),
  );
  return (
    <Section title="Your agent CLIs">
      {server && option && installable && (
        <div className="grid gap-4 rounded-xl border border-border/80 bg-card p-4">
          {server.options.length > 1 ? (
            <OptionPicker
              options={server.options}
              selected={optionIndex}
              onSelect={(index) => {
                setOptionIndex(index);
                setValues({});
              }}
            />
          ) : (
            <p className="text-[12px] text-muted-foreground">
              {option.transport === "stdio" ? "The CLI runs " : "The CLI connects to "}
              <code className="font-mono text-[11.5px] text-foreground/90">{option.summary}</code>
            </p>
          )}
          <McpValuesForm
            option={option}
            values={values}
            onValuesChange={setValues}
            serverName={serverName}
            onServerNameChange={setServerName}
          />
        </div>
      )}
      <div className="overflow-hidden rounded-xl border border-border/80 bg-card">
        {clis.map((cli) => {
          const installations =
            listing?.installations.filter((item) => item.provider_id === cli.provider_id) ?? [];
          if (installations.length)
            return installations.map((installation) => (
              <InstalledRow
                key={installation.server.name}
                cli={cli}
                label={label}
                installation={installation}
              />
            ));
          return (
            <AvailableRow
              key={cli.provider_id}
              cli={cli}
              label={label}
              server={server}
              optionIndex={optionIndex}
              serverName={serverName}
              values={values}
              ready={ready}
            />
          );
        })}
      </div>
      {missing.length > 0 && (
        <p className="text-[11.5px] text-muted-foreground">
          Fill in {missing.map((input) => input.label).join(", ")} to add this server.
        </p>
      )}
    </Section>
  );
}

/** A CLI without this server: why it can't take it, or the button that adds it. */
function AvailableRow({
  cli,
  label,
  server,
  optionIndex,
  serverName,
  values,
  ready,
}: {
  cli: ExtensionCliSummary;
  label: string;
  server: McpRegistryServer | null;
  optionIndex: number;
  serverName: string;
  values: Record<string, string>;
  ready: boolean;
}): React.JSX.Element {
  const option = server?.options[optionIndex];
  const reason = !cli.installed
    ? `${cli.label} is not installed on this computer.`
    : option
      ? optionUnsupportedReason(cli, option, values)
      : "Not in the MCP Registry, so there is nothing to install from here.";
  return (
    <CliRow cli={cli} status={reason ?? "Not installed in this CLI"}>
      {!reason && server && (
        <ActionButton
          action={{
            kind: "mcp-install",
            label,
            cliLabel: cli.label,
            request: {
              provider_id: cli.provider_id,
              registry_name: server.name,
              option: optionIndex,
              server_name: serverName.trim(),
              values,
            },
          }}
          idle={`Add to ${cli.label}`}
          busyLabel="Adding…"
          disabled={!ready}
        />
      )}
    </CliRow>
  );
}

function InstalledRow({
  cli,
  label,
  installation,
}: {
  cli: ExtensionCliSummary;
  label: string;
  installation: McpInstallation;
}): React.JSX.Element {
  const { server, update, update_blocked: blocked } = installation;
  const target = {
    label,
    cliLabel: cli.label,
    providerId: cli.provider_id,
    serverName: server.name,
  };
  return (
    <CliRow
      cli={cli}
      status={
        <span className="font-mono text-[10.5px]">
          {installationSummary(installation)}
          {update && <span className="text-primary"> → {update}</span>}
        </span>
      }
      detail={
        server.managed_by
          ? `Managed by ${server.managed_by}; change it there.`
          : // Health first, then why an available update must happen in the config.
            [server.status, server.enabled ? null : "Disabled", update ? blocked : null]
              .filter(Boolean)
              .join(" · ") || null
      }
    >
      {!server.managed_by && update && !blocked && (
        <ActionButton
          action={{ kind: "mcp-update", ...target }}
          idle={`Update to ${update}`}
          busyLabel="Updating…"
        />
      )}
      {!server.managed_by && (
        <RemoveButton
          action={{ kind: "mcp-remove", ...target }}
          description={`${cli.label} stops loading ${server.name} in new sessions. Other CLIs keep their own copy.`}
        />
      )}
    </CliRow>
  );
}

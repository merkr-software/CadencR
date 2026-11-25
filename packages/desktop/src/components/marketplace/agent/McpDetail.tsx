import { UiTrans, useUiTranslation } from "@/lib/i18n/ui";
import { Link } from "@tanstack/react-router";
import { Loader2, PackageX } from "lucide-react";
import type { ExtensionCliSummary, McpListing, McpRegistryServer } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useExtensionClis,
  useInstalledMcpServers,
  useMcpRegistryServer,
} from "@/hooks/useAgentExtensions";
import { mcpClis, mcpTitle, mcpUpdateVersion } from "@/lib/agent-extensions";
import { KINDS } from "../kinds";
import { MarketplaceEmpty } from "../MarketplaceStates";
import { DetailPage } from "../PluginDetail";
import { formatDay, KindChips } from "../PluginBits";
import {
  ExternalLinkValue,
  DetailsSection,
  Section,
  type MarketplaceFact,
} from "../PluginDetailSections";
import { AgentMark, AgentStateBadge } from "./AgentBits";
import { AgentLoadError, CliErrors } from "./AgentStates";
import { McpInstallSection } from "./McpInstallSection";

/** One MCP server: the registry entry, how it runs, and where it is installed. */
export function McpDetail({ id }: { id: string }): React.JSX.Element {
  const { t } = useUiTranslation();
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
          aria-label={t("marketplace.agent.mcpDetail.loadingTheServer", "Loading the server")}
          className="h-[320px] w-full rounded-xl"
        />
      ) : server.isError && !listing ? (
        <AgentLoadError
          error={server.error}
          title={t(
            "marketplace.agent.mcpDetail.loadRegistryServerError",
            "Could not load this server from the MCP Registry",
          )}
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
          title={t(
            "marketplace.agent.mcpDetail.thisServerIsNotInTheMcp",
            "This server is not in the MCP Registry or installed",
          )}
          action={
            <Button asChild size="sm" variant="outline">
              <Link to="/marketplace" search={{ kind: "mcp" }}>
                {t("marketplace.agent.mcpDetail.backToMcpServers", "Back to MCP servers")}
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
  const { t } = useUiTranslation();
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
                {server
                  ? `${server.name} · v${server.version}`
                  : t(
                      "marketplace.agent.mcpDetail.addedOutsideRegistry",
                      "Added outside the MCP Registry",
                    )}
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
              t(
                "marketplace.agent.mcpDetail.localServerDescription",
                "This server was added to an agent CLI directly; the MCP Registry has no entry for it.",
              )}
          </p>
        </div>
        {inventoryLoading ? (
          <Section title={t("marketplace.agent.mcpDetail.yourAgentClIs", "Your agent CLIs")}>
            <div
              role="status"
              className="flex items-center gap-2 rounded-xl border border-border/80 bg-card px-4 py-4 text-[12.5px] text-muted-foreground"
            >
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              {t(
                "marketplace.agent.mcpDetail.loadingCliInventory",
                "Asking each agent CLI which MCP servers it has…",
              )}
            </div>
          </Section>
        ) : (
          <McpInstallSection server={server} listing={listing} clis={mcpClis(clis)} />
        )}
      </div>
      <aside className="min-w-0 space-y-8">
        {server && <McpFacts server={server} />}
        <Section title={t("marketplace.agent.mcpDetail.howThisWorks", "How this works")}>
          <p className="text-[12.5px] leading-[1.55] text-muted-foreground">
            <UiTrans
              i18nKey="marketplace.agent.mcpDetail.installMechanism"
              defaults="Cadencr runs each CLI's own <add>{{add}}</add>, <remove>{{remove}}</remove> and <list>{{list}}</list> commands. The server then works in that CLI everywhere, terminal included, and the CLI starts it, not Cadencr. Registry entries are published by their authors and not reviewed by Cadencr: check the source before adding one."
              components={{ add: <code />, remove: <code />, list: <code /> }}
              values={{ add: "mcp add", remove: "mcp remove", list: "mcp list" }}
            />
          </p>
        </Section>
      </aside>
    </div>
  );
}

function McpFacts({ server }: { server: McpRegistryServer }): React.JSX.Element {
  const { t } = useUiTranslation();
  const facts: MarketplaceFact[] = [
    [
      "registryName",
      t("marketplace.agent.mcpDetail.registryName", "Registry name"),
      <span className="break-all font-mono text-[11.5px]">{server.name}</span>,
    ],
    [
      "version",
      t("marketplace.agent.mcpDetail.version", "Version"),
      <span className="font-mono text-[11.5px]">{server.version}</span>,
    ],
  ];
  if (server.published_at)
    facts.push([
      "published",
      t("marketplace.agent.mcpDetail.published", "Published"),
      formatDay(server.published_at),
    ]);
  if (server.updated_at && server.updated_at !== server.published_at)
    facts.push([
      "updated",
      t("marketplace.agent.mcpDetail.updated", "Updated"),
      formatDay(server.updated_at),
    ]);
  if (server.repository)
    facts.push([
      "source",
      t("marketplace.agent.mcpDetail.source", "Source"),
      <ExternalLinkValue url={server.repository} />,
    ]);
  if (server.website)
    facts.push([
      "website",
      t("marketplace.agent.mcpDetail.website", "Website"),
      <ExternalLinkValue url={server.website} />,
    ]);
  facts.push([
    "listedBy",
    t("marketplace.agent.mcpDetail.listedBy", "Listed by"),
    <ExternalLinkValue url="https://registry.modelcontextprotocol.io" />,
  ]);
  return <DetailsSection facts={facts} />;
}

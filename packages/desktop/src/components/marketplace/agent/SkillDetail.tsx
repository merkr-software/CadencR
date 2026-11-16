import { Link } from "@tanstack/react-router";
import { PackageX } from "lucide-react";
import type { ExtensionCliSummary, InstalledSkill, SkillListing } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useExtensionClis, useSkillCatalog } from "@/hooks/useAgentExtensions";
import {
  skillCliStates,
  skillIsChangeable,
  skillMarketplaces,
  skillUpdates,
} from "@/lib/agent-extensions";
import { KINDS } from "../kinds";
import { MarketplaceEmpty } from "../MarketplaceStates";
import { DetailPage } from "../PluginDetail";
import { formatDay, KindChips } from "../PluginBits";
import { Section } from "../PluginDetailSections";
import { AgentMark, AgentStateBadge } from "./AgentBits";
import { AgentLoadError, CliErrors } from "./AgentStates";
import { ActionButton, CliRow, RemoveButton } from "./CliRow";

/** One skill pack: what each CLI's marketplace offers and what each has installed. */
export function SkillDetail({ id }: { id: string }): React.JSX.Element {
  const clis = useExtensionClis();
  const catalog = useSkillCatalog({ q: id, limit: 200 });
  const listing = catalog.data?.skills.find((item) => item.key === id);
  return (
    <DetailPage kind="skill" name={listing?.name ?? id} className={KINDS.skill.tone}>
      <CliErrors errors={catalog.data?.errors} clis={clis.data?.clis ?? []} />
      {catalog.isPending || clis.isPending ? (
        <Skeleton
          role="status"
          aria-label="Loading the skill"
          className="h-[280px] w-full rounded-xl"
        />
      ) : catalog.isError ? (
        <AgentLoadError
          error={catalog.error}
          what="the skill marketplaces"
          retrying={catalog.isFetching}
          onRetry={() => void catalog.refetch()}
        />
      ) : listing ? (
        <SkillDetailBody listing={listing} clis={clis.data?.clis ?? []} />
      ) : (
        <MarketplaceEmpty
          icon={PackageX}
          title="No agent CLI offers or has this skill"
          action={
            <Button asChild size="sm" variant="outline">
              <Link to="/marketplace" search={{ kind: "skill" }}>
                Back to skills
              </Link>
            </Button>
          }
        />
      )}
    </DetailPage>
  );
}

function SkillDetailBody({
  listing,
  clis,
}: {
  listing: SkillListing;
  clis: ExtensionCliSummary[];
}): React.JSX.Element {
  const carriers = new Set(listing.installed.map((skill) => skill.provider_id));
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-8">
        <div className="space-y-4">
          <div className="flex items-center gap-4">
            <AgentMark kind="skill" name={listing.name} size={64} />
            <div className="min-w-0 space-y-1">
              <h1 className="text-[26px] font-bold leading-tight tracking-[-0.015em]">
                {listing.name}
              </h1>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {skillMarketplaces(listing).join(", ") || "Skill folder outside any marketplace"}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <KindChips kinds={["skill"]} />
            <AgentStateBadge
              installedIn={carriers.size}
              update={skillUpdates(listing)[0]?.update}
            />
          </div>
          <p className="max-w-[62ch] text-[14.5px] leading-[1.6] text-foreground/90">
            {listing.description || "No description in the marketplace."}
          </p>
        </div>
        <Section title="Your agent CLIs">
          <div className="overflow-hidden rounded-xl border border-border/80 bg-card">
            {skillCliStates(listing, clis).map(({ cli, installed, offer }) =>
              installed.length ? (
                installed.map((skill) => (
                  <InstalledSkillRow key={skill.id} cli={cli} skill={skill} />
                ))
              ) : (
                <CliRow
                  key={cli.provider_id}
                  cli={cli}
                  status={
                    !cli.installed ? (
                      `${cli.label} is not installed on this computer.`
                    ) : offer ? (
                      <span className="font-mono text-[10.5px]">
                        {offer.plugin_id}
                        {offer.version && ` · ${offer.version}`}
                        {offer.install_count
                          ? ` · ${offer.install_count.toLocaleString()} installs`
                          : ""}
                      </span>
                    ) : (
                      `Not offered by the marketplaces ${cli.label} uses.`
                    )
                  }
                >
                  {cli.installed && offer && (
                    <ActionButton
                      action={{
                        kind: "skill-install",
                        label: listing.name,
                        cliLabel: cli.label,
                        providerId: cli.provider_id,
                        pluginId: offer.plugin_id,
                      }}
                      idle={`Install in ${cli.label}`}
                      busyLabel="Installing…"
                    />
                  )}
                </CliRow>
              ),
            )}
          </div>
        </Section>
      </div>
      <aside className="min-w-0 space-y-8">
        <Section title="How this works">
          <p className="text-[12.5px] leading-[1.55] text-muted-foreground">
            Skill packs come from the plugin marketplaces each CLI already uses, and Cadencr
            installs them with that CLI's own <code>plugin</code> commands. Packs with the same name
            in two CLIs are shown together; each CLI keeps its own copy. New sessions load a change.
            Skill folders placed by hand are listed but left to you.
          </p>
        </Section>
      </aside>
    </div>
  );
}

function InstalledSkillRow({
  cli,
  skill,
}: {
  cli: ExtensionCliSummary;
  skill: InstalledSkill;
}): React.JSX.Element {
  const target = {
    label: skill.name,
    cliLabel: cli.label,
    providerId: cli.provider_id,
    pluginId: skill.id,
  };
  const local = skill.source === "local";
  const projectScope = !local && !skillIsChangeable(skill);
  const installedOn = formatDay(skill.installed_at);
  return (
    <CliRow
      cli={cli}
      status={
        <span className="font-mono text-[10.5px]">
          {local ? skill.path : skill.id}
          {skill.version && ` · ${skill.version}`}
          {skill.update && <span className="text-primary"> → {skill.update}</span>}
        </span>
      }
      detail={
        local
          ? "A skill folder outside any marketplace: no CLI command manages it, so edit or delete it there."
          : projectScope
            ? `Installed for one project (${skill.scope} scope): manage it from that project.`
            : [
                skill.enabled === false ? "Disabled" : null,
                installedOn && `Installed ${installedOn}`,
              ]
                .filter(Boolean)
                .join(" · ") || null
      }
    >
      {skillIsChangeable(skill) && cli.support.skill_update && (
        <ActionButton
          action={{ kind: "skill-update", ...target }}
          idle={skill.update ? `Update to ${skill.update}` : "Check for update"}
          busyLabel="Updating…"
          variant={skill.update ? "default" : "outline"}
        />
      )}
      {skillIsChangeable(skill) && (
        <RemoveButton
          action={{ kind: "skill-remove", ...target }}
          description={`${cli.label} uninstalls ${skill.id}. Other CLIs keep their own copy.`}
        />
      )}
    </CliRow>
  );
}

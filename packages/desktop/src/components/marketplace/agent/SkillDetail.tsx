import { UiTrans, useUiTranslation } from "@/lib/i18n/ui";
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
  const { t } = useUiTranslation();
  const clis = useExtensionClis();
  const catalog = useSkillCatalog({ q: id, limit: 200 });
  const listing = catalog.data?.skills.find((item) => item.key === id);
  return (
    <DetailPage kind="skill" name={listing?.name ?? id} className={KINDS.skill.tone}>
      <CliErrors errors={catalog.data?.errors} clis={clis.data?.clis ?? []} />
      {catalog.isPending || clis.isPending ? (
        <Skeleton
          role="status"
          aria-label={t("marketplace.agent.skillDetail.loadingTheSkill", "Loading the skill")}
          className="h-[280px] w-full rounded-xl"
        />
      ) : catalog.isError ? (
        <AgentLoadError
          error={catalog.error}
          title={t(
            "marketplace.agent.loadSkillMarketplacesError",
            "Could not load the skill marketplaces",
          )}
          retrying={catalog.isFetching}
          onRetry={() => void catalog.refetch()}
        />
      ) : listing ? (
        <SkillDetailBody listing={listing} clis={clis.data?.clis ?? []} />
      ) : (
        <MarketplaceEmpty
          icon={PackageX}
          title={t(
            "marketplace.agent.skillDetail.noAgentCliOffersOrHasThis",
            "No agent CLI offers or has this skill",
          )}
          action={
            <Button asChild size="sm" variant="outline">
              <Link to="/marketplace" search={{ kind: "skill" }}>
                {t("marketplace.agent.skillDetail.backToSkills", "Back to skills")}
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
  const { t } = useUiTranslation();
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
                {skillMarketplaces(listing).join(", ") ||
                  t(
                    "marketplace.agent.skillDetail.outsideMarketplace",
                    "Skill folder outside any marketplace",
                  )}
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
            {listing.description ||
              t("marketplace.agent.skillDescriptionMissing", "No description in the marketplace.")}
          </p>
        </div>
        <Section title={t("marketplace.agent.yourClis", "Your agent CLIs")}>
          <SkillCliRows listing={listing} clis={clis} />
        </Section>
      </div>
      <aside className="min-w-0 space-y-8">
        <Section title={t("marketplace.agent.skillDetail.howThisWorks", "How this works")}>
          <p className="text-[12.5px] leading-[1.55] text-muted-foreground">
            <UiTrans
              i18nKey="marketplace.agent.skillDetail.installMechanism"
              defaults="Skill packs come from the plugin marketplaces each CLI already uses, and Cadencr installs them with that CLI's own <command>{{command}}</command> commands. Packs with the same name in two CLIs are shown together; each CLI keeps its own copy. New sessions load a change. Skill folders placed by hand are listed but left to you."
              components={{ command: <code /> }}
              values={{ command: "plugin" }}
            />
          </p>
        </Section>
      </aside>
    </div>
  );
}

function SkillCliRows({
  listing,
  clis,
}: {
  listing: SkillListing;
  clis: ExtensionCliSummary[];
}): React.JSX.Element {
  const { t } = useUiTranslation();
  return (
    <div className="overflow-hidden rounded-xl border border-border/80 bg-card">
      {skillCliStates(listing, clis).map(({ cli, installed, offer }) =>
        installed.length ? (
          installed.map((skill) => <InstalledSkillRow key={skill.id} cli={cli} skill={skill} />)
        ) : (
          <CliRow
            key={cli.provider_id}
            cli={cli}
            status={
              !cli.installed ? (
                t(
                  "marketplace.agent.cliNotInstalled",
                  "{{cli}} is not installed on this computer.",
                  { cli: cli.label },
                )
              ) : offer ? (
                <span className="font-mono text-[10.5px]">
                  {offer.plugin_id}
                  {offer.version && ` · ${offer.version}`}
                  {offer.install_count
                    ? " · " +
                      t("marketplace.agent.skillInstallCount", "{{count, number}} installs", {
                        count: offer.install_count,
                        defaultValue_zero: "{{count, number}} installs",
                        defaultValue_one: "{{count, number}} install",
                      })
                    : ""}
                </span>
              ) : (
                t(
                  "marketplace.agent.skillDetail.notOffered",
                  "Not offered by the marketplaces {{cli}} uses.",
                  { cli: cli.label },
                )
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
                idle={t("marketplace.agent.skillDetail.installInCli", "Install in {{cli}}", {
                  cli: cli.label,
                })}
                busyLabel={t("marketplace.agent.skillDetail.installing", "Installing…")}
              />
            )}
          </CliRow>
        ),
      )}
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
  const { t } = useUiTranslation();
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
          ? t(
              "marketplace.agent.skillDetail.localFolderExplanation",
              "A skill folder outside any marketplace: no CLI command manages it, so edit or delete it there.",
            )
          : projectScope
            ? t(
                "marketplace.agent.skillDetail.projectScope",
                "Installed for one project ({{scope}} scope): manage it from that project.",
                { scope: skill.scope },
              )
            : [
                skill.enabled === false ? t("marketplace.agent.disabled", "Disabled") : null,
                installedOn &&
                  t("marketplace.agent.skillDetail.installedOn", "Installed {{date}}", {
                    date: installedOn,
                  }),
              ]
                .filter(Boolean)
                .join(" · ") || null
      }
    >
      {skillIsChangeable(skill) && cli.support.skill_update && (
        <ActionButton
          action={{ kind: "skill-update", ...target }}
          idle={
            skill.update
              ? t("marketplace.agent.updateToVersion", "Update to {{version}}", {
                  version: skill.update,
                })
              : t("marketplace.agent.skillDetail.checkForUpdate", "Check for update")
          }
          busyLabel={t("marketplace.agent.updating", "Updating…")}
          variant={skill.update ? "default" : "outline"}
        />
      )}
      {skillIsChangeable(skill) && (
        <RemoveButton
          action={{ kind: "skill-remove", ...target }}
          description={t(
            "marketplace.agent.skillDetail.removeFromCli",
            "{{cli}} uninstalls {{id}}. Other CLIs keep their own copy.",
            { cli: cli.label, id: skill.id },
          )}
        />
      )}
    </CliRow>
  );
}

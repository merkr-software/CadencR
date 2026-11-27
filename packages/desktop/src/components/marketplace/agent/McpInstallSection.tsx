import { useMemo, useState } from "react";
import type {
  ExtensionCliSummary,
  McpInstallation,
  McpInstallOption,
  McpListing,
  McpRegistryServer,
} from "@/api/generated";
import { UiTrans, useUiTranslation, type UiTranslator } from "@/lib/i18n/ui";
import { defaultServerName, mcpTitle, optionUnsupportedReason } from "@/lib/agent-extensions";
import { Section } from "../PluginDetailSections";
import { ActionButton, CliRow, RemoveButton } from "./CliRow";
import { McpValuesForm, missingInputs, OptionPicker, SERVER_NAME_PATTERN } from "./McpInstallForm";

function installationSummary(installation: McpInstallation, t: UiTranslator): string {
  const { server, package: pkg } = installation;
  const where = server.url ?? [server.command, ...server.args].filter(Boolean).join(" ");
  const version = pkg?.version
    ? ` · ${pkg.version}`
    : pkg
      ? ` · ${t("marketplace.agent.mcpDetail.newestOnEveryLaunch", "newest package on each launch")}`
      : "";
  return `${server.name}${version} — ${where}`;
}

export function McpInstallSection({
  server,
  listing,
  clis,
}: {
  server: McpRegistryServer | null;
  listing?: McpListing;
  clis: ExtensionCliSummary[];
}): React.JSX.Element {
  const { t } = useUiTranslation();
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
    <Section title={t("marketplace.agent.yourClis", "Your agent CLIs")}>
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
              <OptionSummary option={option} />
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
          {t(
            "marketplace.agent.mcpDetail.missingInputs",
            "Fill in {{inputs}} to add this server.",
            { inputs: missing.map((input) => input.label).join(", ") },
          )}
        </p>
      )}
    </Section>
  );
}

function OptionSummary({ option }: { option: McpInstallOption }): React.JSX.Element {
  const components = {
    target: <code className="font-mono text-[11.5px] text-foreground/90" />,
  };
  const values = { target: option.summary };
  return option.transport === "stdio" ? (
    <UiTrans
      i18nKey="marketplace.agent.mcpDetail.cliRuns"
      defaults="The CLI runs <target>{{target}}</target>"
      components={components}
      values={values}
    />
  ) : (
    <UiTrans
      i18nKey="marketplace.agent.mcpDetail.cliConnects"
      defaults="The CLI connects to <target>{{target}}</target>"
      components={components}
      values={values}
    />
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
  const { t } = useUiTranslation();
  const option = server?.options[optionIndex];
  const reason = !cli.installed
    ? t("marketplace.agent.cliNotInstalled", "{{cli}} is not installed on this computer.", {
        cli: cli.label,
      })
    : option
      ? optionUnsupportedReason(cli, option, values, t)
      : t(
          "marketplace.agent.mcpDetail.localServerUnavailable",
          "Not in the MCP Registry, so there is nothing to install from here.",
        );
  return (
    <CliRow
      cli={cli}
      status={
        reason ?? t("marketplace.agent.mcpDetail.notInstalledHere", "Not installed in this CLI")
      }
    >
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
          idle={t("marketplace.agent.mcpDetail.addToCli", "Add to {{cli}}", { cli: cli.label })}
          busyLabel={t("marketplace.agent.mcpDetail.adding", "Adding…")}
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
  const { t } = useUiTranslation();
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
          {installationSummary(installation, t)}
          {update && <span className="text-primary"> → {update}</span>}
        </span>
      }
      detail={
        server.managed_by
          ? t("marketplace.agent.mcpDetail.managedBy", "Managed by {{manager}}; change it there.", {
              manager: server.managed_by,
            })
          : // Health first, then why an available update must happen in the config.
            [
              server.status,
              server.enabled ? null : t("marketplace.agent.disabled", "Disabled"),
              update ? blocked : null,
            ]
              .filter(Boolean)
              .join(" · ") || null
      }
    >
      {!server.managed_by && update && !blocked && (
        <ActionButton
          action={{ kind: "mcp-update", ...target }}
          idle={t("marketplace.agent.updateToVersion", "Update to {{version}}", {
            version: update,
          })}
          busyLabel={t("marketplace.agent.updating", "Updating…")}
        />
      )}
      {!server.managed_by && (
        <RemoveButton
          action={{ kind: "mcp-remove", ...target }}
          description={t(
            "marketplace.agent.mcpDetail.removeFromCli",
            "{{cli}} stops loading {{name}} in new sessions. Other CLIs keep their own copy.",
            { cli: cli.label, name: server.name },
          )}
        />
      )}
    </CliRow>
  );
}

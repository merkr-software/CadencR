import { useAgentCatalog, type RuntimeProviderOption } from "@/api/agentRuntime";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { providerAccessModeConfig } from "@/lib/provider-access-modes";
import { ProviderIcon } from "@/lib/provider-icons";
import { getProviderMetadata, PROVIDER_IDS, type ProviderId } from "@/lib/providers";
import { CLAUDE_BYPASS_PERMISSIONS_SETTING_KEY } from "@/shared/permission-mode-settings";
import { BinaryDiscoverySection } from "./BinaryDiscoverySection";
import { ProviderAccessModeSetting } from "./ProviderAccessModeSetting";
import { CustomModelsSection } from "./CustomModelsSection";
import { CodexProfilesSection } from "./CodexProfilesSection";
import { DangerousModeToggle } from "./DangerousModeToggle";
import { ProfilesSection } from "./ProfilesSection";
import { ProviderDevelopmentCard } from "./ProviderDevelopmentCard";
import { ProviderUpdatesCard } from "./ProviderUpdatesCard";
import { SettingsGroup } from "./SettingsGroup";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";
import { SettingsPageSection } from "./SettingsPageSection";
import { SettingsSubsection } from "./SettingsSubsection";

const PROVIDER_TABS: ProviderId[] = [
  PROVIDER_IDS.CLAUDE_CODE,
  PROVIDER_IDS.OPENCODE,
  PROVIDER_IDS.CODEX_CLI,
];

/**
 * Catalog providers without a built-in panel that still have something to
 * configure here — today a catalog-declared access mode.
 */
function useConfigurableCatalogProviders(): RuntimeProviderOption[] {
  const { data } = useAgentCatalog();
  return (data?.providers ?? []).filter(
    (provider) =>
      !(PROVIDER_TABS as readonly string[]).includes(provider.id) &&
      providerAccessModeConfig(provider.id, {
        label: provider.label,
        accessModes: provider.access_modes ?? [],
      }) !== null,
  );
}

export function ProvidersSection(): React.JSX.Element {
  const catalogProviders = useConfigurableCatalogProviders();
  return (
    <SettingsPageSection pageId="providers">
      <ProviderUpdatesCard />
      <SettingsGroup
        id={SETTINGS_ANCHORS.providerConfig}
        title="Configuration"
        description="Each provider's install, profiles and permission options."
      >
        <Tabs defaultValue={PROVIDER_IDS.CLAUDE_CODE}>
          <TabsList aria-label="Provider" className="px-2">
            {PROVIDER_TABS.map((id) => (
              <TabsTrigger key={id} value={id}>
                <ProviderIcon providerId={id} alt="" className="size-4 rounded-sm shrink-0" />
                <span>{getProviderMetadata(id)?.label ?? id}</span>
              </TabsTrigger>
            ))}
            {catalogProviders.map((provider) => (
              <TabsTrigger key={provider.id} value={provider.id}>
                <ProviderIcon
                  providerId={provider.id}
                  alt=""
                  className="size-4 rounded-sm shrink-0"
                />
                <span>{provider.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={PROVIDER_IDS.CLAUDE_CODE}>
            <ClaudeProviderPanel />
          </TabsContent>
          <TabsContent value={PROVIDER_IDS.OPENCODE}>
            <OpencodeProviderPanel />
          </TabsContent>
          <TabsContent value={PROVIDER_IDS.CODEX_CLI}>
            <CodexProviderPanel />
          </TabsContent>
          {catalogProviders.map((provider) => (
            <TabsContent key={provider.id} value={provider.id}>
              <SettingsSubsection>
                <ProviderAccessModeSetting providerId={provider.id} />
              </SettingsSubsection>
            </TabsContent>
          ))}
        </Tabs>
      </SettingsGroup>
      <ProviderDevelopmentCard />
    </SettingsPageSection>
  );
}

function ClaudeProviderPanel(): React.JSX.Element {
  return (
    <>
      <SettingsSubsection>
        <BinaryDiscoverySection
          discoveryKey="claude"
          description={
            <>
              Every <strong>claude</strong> install Cadencr found on disk. The selected one is what
              gets spawned. To override, set a path during onboarding.
            </>
          }
        />
      </SettingsSubsection>
      <SettingsSubsection>
        <ProfilesSection />
      </SettingsSubsection>
      <SettingsSubsection>
        <CustomModelsSection />
      </SettingsSubsection>
      <DangerousModeToggle
        variant="subsection"
        settingKey={CLAUDE_BYPASS_PERMISSIONS_SETTING_KEY}
        title="Allow BypassPermissions"
        description={
          <>
            Adds <strong>Bypass</strong> to Claude's permission-mode selector and cycle. Enabling
            this setting makes the mode available; Claude only skips checks when the current mode is
            Bypass.
          </>
        }
        warningTitle="Enable BypassPermissions for Claude?"
        warningBody={
          <>
            <p>
              BypassPermissions disables every safety check. Claude can edit, delete, and run any
              command without confirmation, including destructive ones.
            </p>
            <p>
              Only enable this in isolated environments (containers, VMs, dev containers) where
              Claude cannot damage your host system. You can always toggle it off later.
            </p>
          </>
        }
      />
    </>
  );
}

function OpencodeProviderPanel(): React.JSX.Element {
  return (
    <SettingsSubsection>
      <BinaryDiscoverySection
        discoveryKey="opencode"
        description={
          <>
            Every <strong>opencode</strong> install Cadencr found on disk. The selected one is
            spawned as <strong>opencode acp</strong>; override via onboarding or the{" "}
            <strong>opencode_cli_path</strong> workspace setting.
          </>
        }
      />
    </SettingsSubsection>
  );
}

function CodexProviderPanel(): React.JSX.Element {
  return (
    <>
      <SettingsSubsection>
        <BinaryDiscoverySection
          discoveryKey="codex"
          description={
            <>
              Every <strong>codex</strong> install Cadencr found on disk. The selected one is used
              to start <strong>codex app-server</strong>; override via onboarding or the{" "}
              <strong>codex_cli_path</strong> workspace setting.
            </>
          }
        />
      </SettingsSubsection>
      <SettingsSubsection>
        <CodexProfilesSection />
      </SettingsSubsection>
      <SettingsSubsection>
        <ProviderAccessModeSetting providerId={PROVIDER_IDS.CODEX_CLI} />
      </SettingsSubsection>
    </>
  );
}

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProviderIcon } from "@/lib/provider-icons";
import { getProviderMetadata, PROVIDER_IDS, type ProviderId } from "@/lib/providers";
import { CLAUDE_BYPASS_PERMISSIONS_SETTING_KEY } from "@/shared/permission-mode-settings";
import { BinaryDiscoverySection } from "./BinaryDiscoverySection";
import { CodexPermissionModeSetting } from "./CodexPermissionModeSetting";
import { CustomModelsSection } from "./CustomModelsSection";
import { DangerousModeToggle } from "./DangerousModeToggle";
import { ProfilesSection } from "./ProfilesSection";
import { SettingsCard } from "./SettingsCard";
import { SettingsSection } from "./SettingsSection";
import { SettingsSubsection } from "./SettingsSubsection";

const PROVIDER_TABS: ProviderId[] = [
  PROVIDER_IDS.CLAUDE_CODE,
  PROVIDER_IDS.OPENCODE,
  PROVIDER_IDS.CODEX_CLI,
];

export function ProvidersSection(): React.JSX.Element {
  return (
    <SettingsSection
      id="providers"
      title="CLI Providers"
      subtitle="Binaries · Profiles · Permission modes"
    >
      <SettingsCard padded={false}>
        <Tabs defaultValue={PROVIDER_IDS.CLAUDE_CODE}>
          <TabsList aria-label="Provider" className="px-2">
            {PROVIDER_TABS.map((id) => (
              <TabsTrigger key={id} value={id}>
                <ProviderIcon providerId={id} alt="" className="size-4 rounded-sm shrink-0" />
                <span>{getProviderMetadata(id)?.label ?? id}</span>
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
        </Tabs>
      </SettingsCard>
    </SettingsSection>
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
        <CodexPermissionModeSetting />
      </SettingsSubsection>
    </>
  );
}

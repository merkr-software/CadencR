import type { ReactElement } from "react";
import { Loader2Icon, Trash2Icon } from "lucide-react";
import { GitHost, type ForgeAuthStatus } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LabeledControl } from "@/components/settings/LabeledControl";
import { useUiTranslation } from "@/lib/i18n/ui";
import { forgeKindCapabilities } from "./forge-kind-capabilities";

interface ForgeHostControlsProps {
  status: ForgeAuthStatus;
  disabled: boolean;
  kind: GitHost;
  apiBaseUrl: string;
  username: string;
  token: string;
  useCliAuth: boolean;
  onKindChange: (value: GitHost) => void;
  onApiBaseUrlChange: (value: string) => void;
  onUsernameChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  onUseCliAuthChange: (value: boolean) => void;
}

export function ForgeHostControls({
  status,
  disabled,
  kind,
  apiBaseUrl,
  username,
  token,
  useCliAuth,
  onKindChange,
  onApiBaseUrlChange,
  onUsernameChange,
  onTokenChange,
  onUseCliAuthChange,
}: ForgeHostControlsProps): ReactElement {
  const { t } = useUiTranslation();
  const capabilities = forgeKindCapabilities(kind);
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <LabeledControl label={t("workspace.git.gitRemotesSettings.provider", "Provider")}>
          <Select
            value={kind}
            onValueChange={(value) => onKindChange(value as GitHost)}
            disabled={disabled}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.values(GitHost).map((value) => (
                <SelectItem key={value} value={value}>
                  {value === GitHost.Other
                    ? t("workspace.git.gitRemotesSettings.otherProvider", "Other")
                    : value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </LabeledControl>
        <LabeledControl
          label={t("workspace.git.gitRemotesSettings.apiBaseUrl", "API base URL")}
          hint={t(
            "workspace.git.gitRemotesSettings.requiredForCustomSelfHostedDomains",
            "Required for custom self-hosted domains.",
          )}
        >
          <Input
            value={apiBaseUrl}
            onChange={(event) => onApiBaseUrlChange(event.target.value)}
            placeholder="https://git.example.com/api/…"
            disabled={disabled}
          />
        </LabeledControl>
      </div>
      {capabilities.usernameRequired && (
        <ForgeUsernameField {...{ username, disabled, onUsernameChange }} />
      )}

      <LabeledControl
        label={t("workspace.git.gitRemotesSettings.apiToken", "API token")}
        hint={
          status.token_present
            ? t(
                "workspace.git.gitRemotesSettings.leaveBlankToKeepTheStoredToken",
                "Leave blank to keep the stored token.",
              )
            : undefined
        }
      >
        <Input
          type="password"
          value={token}
          onChange={(event) => onTokenChange(event.target.value)}
          autoComplete="new-password"
          placeholder={
            status.token_present
              ? t("workspace.git.gitRemotesSettings.storedSecurely", "Stored securely")
              : t(
                  "workspace.git.gitRemotesSettings.pasteAReadOnlyApiToken",
                  "Paste a read-only API token",
                )
          }
          disabled={disabled || useCliAuth}
        />
      </LabeledControl>
      {capabilities.cliAuthAvailable && (
        <ForgeCliAuthToggle
          useCliAuth={useCliAuth}
          disabled={disabled}
          onUseCliAuthChange={onUseCliAuthChange}
        />
      )}
    </>
  );
}

export function ForgeHostActions({
  status,
  pending,
  disabled,
  onSave,
  onDisconnect,
}: {
  status: ForgeAuthStatus;
  pending: boolean;
  disabled: boolean;
  onSave: () => void;
  onDisconnect: (hostname: string) => void;
}): ReactElement {
  const { t } = useUiTranslation();
  return (
    <div className="flex items-center justify-end gap-2">
      {(status.token_present || status.use_cli_auth) && (
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => onDisconnect(status.hostname)}
        >
          <Trash2Icon className="mr-1.5 size-3.5" aria-hidden />{" "}
          {t("workspace.git.gitRemotesSettings.disconnect", "Disconnect")}
        </Button>
      )}
      <Button size="sm" disabled={disabled} onClick={onSave}>
        {pending && <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />}
        {t("workspace.git.gitRemotesSettings.testConnection", "Test connection")}
      </Button>
    </div>
  );
}

function ForgeCliAuthToggle({
  useCliAuth,
  disabled,
  onUseCliAuthChange,
}: Pick<ForgeHostControlsProps, "useCliAuth" | "disabled" | "onUseCliAuthChange">): ReactElement {
  const { t } = useUiTranslation();
  return (
    <label className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2">
      <span>
        <span className="block text-sm font-medium">
          {t(
            "workspace.git.gitRemotesSettings.reuseTheInstalledProviderCliToken",
            "Reuse the installed provider CLI token",
          )}
        </span>
        <span className="block text-xs text-muted-foreground">
          {t(
            "workspace.git.gitRemotesSettings.optInToTheAuthenticatedLocalCli",
            "Opt in to the authenticated local CLI when no stored token exists.",
          )}
        </span>
      </span>
      <Switch checked={useCliAuth} onCheckedChange={onUseCliAuthChange} disabled={disabled} />
    </label>
  );
}

function ForgeUsernameField({
  username,
  disabled,
  onUsernameChange,
}: Pick<ForgeHostControlsProps, "username" | "disabled" | "onUsernameChange">): ReactElement {
  const { t } = useUiTranslation();
  return (
    <LabeledControl
      label={t("workspace.git.gitRemotesSettings.atlassianAccountEmail", "Atlassian account email")}
    >
      <Input
        value={username}
        onChange={(event) => onUsernameChange(event.target.value)}
        autoComplete="username"
        disabled={disabled}
      />
    </LabeledControl>
  );
}

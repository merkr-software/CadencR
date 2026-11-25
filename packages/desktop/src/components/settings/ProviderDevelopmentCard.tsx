import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { useCreateProviderWorkspace } from "@/api/generated";
import { Button } from "@/components/ui/button";
import { navigateToFeatureIdOrHome } from "@/components/project-feature-navigation";
import { toastError } from "@/lib/api-errors";
import { invalidateByExactUrl } from "@/lib/queryClient";
import {
  CreateProviderWorkspaceDialog,
  type ProviderWorkspaceDraft,
} from "./CreateProviderWorkspaceDialog";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./SettingsRow";
import { SETTINGS_ANCHORS } from "./settings-anchor-ids";

export function ProviderDevelopmentCard(): React.JSX.Element {
  const { t } = useUiTranslation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { mutate, isPending } = useCreateProviderWorkspace();

  const create = useCallback(
    (draft: ProviderWorkspaceDraft): void => {
      const data = {
        provider_id: draft.providerId,
        display_name: draft.displayName,
        ...(draft.directory ? { directory: draft.directory } : {}),
      };
      mutate(
        {
          data,
        },
        {
          onSuccess: (workspace) => {
            setDialogOpen(false);
            notifyWorkspaceCreated(Boolean(draft.directory));
            navigateToFeatureIdOrHome(navigate, workspace.project_id, workspace.feature_id);
            void invalidateByExactUrl(queryClient, ["/api/projects", "/api/features"]).catch(
              (error: unknown) => {
                toastError(
                  error,
                  translateUi(
                    "settings.providers.providerDevelopmentCard.refreshError",
                    "Provider created, but the project list could not be refreshed",
                  ),
                );
              },
            );
          },
          onError: (error: unknown) => {
            toastError(
              error,
              draft.directory
                ? translateUi(
                    "settings.providers.providerDevelopmentCard.importError",
                    "Failed to import the provider project",
                  )
                : translateUi(
                    "settings.providers.providerDevelopmentCard.createError",
                    "Failed to create the provider project",
                  ),
            );
          },
        },
      );
    },
    [mutate, navigate, queryClient],
  );

  return (
    <>
      <SettingsGroup
        id={SETTINGS_ANCHORS.providerConnector}
        title={t(
          "settings.providers.providerDevelopmentCard.buildAProviderConnector",
          "Build a provider connector",
        )}
        description={t(
          "settings.providers.providerDevelopmentCard.bringAnotherAgentCliIntoCadencrWith",
          "Bring another agent CLI into Cadencr with a code-backed local provider, built in a normal Cadencr workspace.",
        )}
      >
        <SettingsRow
          align="start"
          label={t(
            "settings.providers.providerDevelopmentCard.newProviderProject",
            "New provider project",
          )}
          description={t(
            "settings.providers.providerDevelopmentCard.theScaffoldTellsYourAgentHowTo",
            "The scaffold tells your agent how to implement model discovery and {{protocol}}. Providers register when Cadencr starts, so restart it between changes before testing.",
            { protocol: "ACP v1" },
          )}
          control={
            <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
              <Plus aria-hidden />
              {t("settings.providers.providerDevelopmentCard.addProvider", "Add provider")}
            </Button>
          }
        />
      </SettingsGroup>
      {dialogOpen ? (
        <CreateProviderWorkspaceDialog
          isCreating={isPending}
          onCreate={create}
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
    </>
  );
}

function notifyWorkspaceCreated(imported: boolean): void {
  toast.success(
    imported
      ? translateUi(
          "settings.providers.providerDevelopmentCard.imported",
          "Provider project imported",
        )
      : translateUi(
          "settings.providers.providerDevelopmentCard.created",
          "Provider project created",
        ),
    {
      description: imported
        ? translateUi(
            "settings.providers.providerDevelopmentCard.restartImported",
            "The trusted local connector is registered. Restart Cadencr to test it.",
          )
        : translateUi(
            "settings.providers.providerDevelopmentCard.restartCreated",
            "Ask your agent to read {{file}}, then restart Cadencr to test.",
            { file: "INSTRUCTION.md" },
          ),
    },
  );
}

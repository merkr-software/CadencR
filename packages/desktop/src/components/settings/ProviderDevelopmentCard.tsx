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
            toast.success(
              draft.directory ? "Provider project imported" : "Provider project created",
              {
                description: draft.directory
                  ? "The trusted local connector is registered. Restart Cadencr to test it."
                  : "Ask your agent to read INSTRUCTION.md, then restart Cadencr to test.",
              },
            );
            navigateToFeatureIdOrHome(navigate, workspace.project_id, workspace.feature_id);
            void invalidateByExactUrl(queryClient, ["/api/projects", "/api/features"]).catch(
              (error: unknown) => {
                toastError(error, "Provider created, but the project list could not be refreshed");
              },
            );
          },
          onError: (error: unknown) => {
            toastError(
              error,
              draft.directory
                ? "Failed to import the provider project"
                : "Failed to create the provider project",
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
        title="Build a provider connector"
        description="Bring another agent CLI into Cadencr with a code-backed local provider, built in a normal Cadencr workspace."
      >
        <SettingsRow
          align="start"
          label="New provider project"
          description="The scaffold tells your agent how to implement model discovery and ACP v1. Providers register when Cadencr starts, so restart it between changes before testing."
          control={
            <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
              <Plus aria-hidden />
              Add provider
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

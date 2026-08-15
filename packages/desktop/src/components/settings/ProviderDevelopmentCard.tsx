import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus, RotateCcw } from "lucide-react";
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
import { SettingsCard } from "./SettingsCard";

export function ProviderDevelopmentCard(): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { mutate, isPending } = useCreateProviderWorkspace();

  const create = useCallback(
    (draft: ProviderWorkspaceDraft): void => {
      mutate(
        {
          data: {
            provider_id: draft.providerId,
            display_name: draft.displayName,
          },
        },
        {
          onSuccess: (workspace) => {
            setDialogOpen(false);
            toast.success("Provider project created", {
              description: "Ask your agent to read INSTRUCTION.md, then restart Cadencr to test.",
            });
            navigateToFeatureIdOrHome(navigate, workspace.project_id, workspace.feature_id);
            void invalidateByExactUrl(queryClient, ["/api/projects", "/api/features"]).catch(
              (error: unknown) => {
                toastError(error, "Provider created, but the project list could not be refreshed");
              },
            );
          },
          onError: (error: unknown) => {
            toastError(error, "Failed to create the provider project");
          },
        },
      );
    },
    [mutate, navigate, queryClient],
  );

  return (
    <>
      <SettingsCard
        padded
        title="Build a provider connector"
        description="Start a code-backed local provider in a normal Cadencr workspace."
        action={
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus aria-hidden />
            Add provider
          </Button>
        }
      >
        <div className="flex items-start gap-2 rounded-lg bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground">
          <RotateCcw className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <p>
            The scaffold tells your agent how to implement model discovery and ACP v1. Provider
            registration is restart-gated, so restart Cadencr between changes before testing.
          </p>
        </div>
      </SettingsCard>
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

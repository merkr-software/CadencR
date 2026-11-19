import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  getGetWorkspaceSettingQueryKey,
  getMigrationStatusRouteQueryKey,
  useGetWorkspaceSetting,
  useMigrateToPluginRoute,
  useMigrationStatusRoute,
  type NeovimMigrationStatus,
} from "@/api/generated";
import { useVimModeLevel } from "@/hooks/useVimModeLevel";
import { apiErrorMessage } from "@/lib/api-errors";
import { EDITOR_BACKEND_KEY, resolveEditorId } from "@/lib/editors/editor-registry";

/** What the user must do before the plugin can take over the editor. */
function migrationHint(data: NeovimMigrationStatus): React.JSX.Element {
  if (data.plugin === "ready") {
    return data.sessions_running.length > 0 ? (
      <p className="text-xs text-muted-foreground">
        Save and quit your open full Neovim sessions first ({data.sessions_running.length}{" "}
        conversations active), then retry.
      </p>
    ) : (
      <p className="text-xs text-muted-foreground">
        Takes effect immediately. You can switch back to the built-in editor here at any time.
      </p>
    );
  }
  if (data.plugin === "consent_required" || data.plugin === "disabled") {
    return (
      <p className="text-xs text-muted-foreground">
        {data.plugin === "consent_required"
          ? "Review and accept the Neovim plugin's permissions, then enable it."
          : "Enable the Neovim plugin first."}{" "}
        <Link to="/settings" search={{ section: "custom-tabs" }} className="underline">
          Open Custom tabs
        </Link>
      </p>
    );
  }
  if (data.plugin === "not_installed") {
    return (
      <p className="text-xs text-muted-foreground">
        Install the Neovim plugin from the Marketplace first.{" "}
        <Link to="/marketplace" className="underline">
          Open Marketplace
        </Link>
      </p>
    );
  }
  if (data.plugin === "blocked") {
    return (
      <p className="text-xs text-muted-foreground">
        The Neovim plugin is blocked by CadencR's revocation policy and cannot be used as your
        editor.
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      The installed Neovim plugin cannot run as an editor here.
    </p>
  );
}

/**
 * Offers users of the built-in full Neovim editor the switch to the standalone
 * Neovim plugin. Hidden once another editor is selected; the built-in editor
 * stays available during the coexistence period, so switching back is just
 * picking "Full Neovim" again in the editor setting.
 */
export function NeovimPluginMigration(): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const setting = useGetWorkspaceSetting(EDITOR_BACKEND_KEY);
  const vim = useVimModeLevel();
  const id = resolveEditorId(setting.data?.value, vim);
  const status = useMigrationStatusRoute({
    query: {
      enabled: id === "neovim",
      // While built-in sessions are alive the guard keeps refusing; poll so
      // the button unlocks as soon as the user has saved and quit them.
      refetchInterval: (query) =>
        (query.state.data?.sessions_running.length ?? 0) > 0 ? 5000 : false,
    },
  });
  const migrate = useMigrateToPluginRoute();
  const [error, setError] = useState<string | null>(null);

  if (id !== "neovim") return null;
  const data = status.data;
  if (!data) return null;

  const onMigrate = async (): Promise<void> => {
    setError(null);
    try {
      await migrate.mutateAsync();
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: getGetWorkspaceSettingQueryKey(EDITOR_BACKEND_KEY),
        }),
        queryClient.invalidateQueries({ queryKey: getMigrationStatusRouteQueryKey() }),
      ]);
      toast.success("Editor switched to the Neovim plugin.");
    } catch (err) {
      setError(apiErrorMessage(err, "The migration to the Neovim plugin failed."));
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <div className="text-sm font-medium">Move full Neovim to the Neovim plugin</div>
      <p className="text-xs text-muted-foreground">
        The built-in full Neovim editor will move to a plugin. It reuses your installed Neovim and
        your configuration; nothing is installed for you.
      </p>
      {data.plugin === "ready" && (
        <Button
          type="button"
          size="sm"
          onClick={() => void onMigrate()}
          disabled={data.sessions_running.length > 0 || migrate.isPending}
        >
          Switch to the Neovim plugin
        </Button>
      )}
      {migrationHint(data)}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

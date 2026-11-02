import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  installMcpServer,
  installSkill,
  removeMcpServer,
  removeSkill,
  updateMcpServer,
  updateSkill,
  type McpInstallRequest,
} from "@/api/generated";
import { INVENTORY_URLS } from "@/lib/agent-extensions";
import { toastError } from "@/lib/api-errors";
import { invalidateByUrlPrefix } from "@/lib/queryClient";

export type AgentExtensionAction =
  | { kind: "mcp-install"; label: string; cliLabel: string; request: McpInstallRequest }
  | {
      kind: "mcp-remove" | "mcp-update";
      label: string;
      cliLabel: string;
      providerId: string;
      serverName: string;
    }
  | {
      kind: "skill-install" | "skill-remove" | "skill-update";
      label: string;
      cliLabel: string;
      providerId: string;
      pluginId: string;
    };

/** One key per CLI and target, so two CLIs can change the same server at once. */
export function actionKey(action: AgentExtensionAction): string {
  switch (action.kind) {
    case "mcp-install":
      return `mcp:${action.request.provider_id}:${action.request.server_name}`;
    case "mcp-remove":
    case "mcp-update":
      return `mcp:${action.providerId}:${action.serverName}`;
    default:
      return `skill:${action.providerId}:${action.pluginId}`;
  }
}

async function execute(action: AgentExtensionAction): Promise<string> {
  switch (action.kind) {
    case "mcp-install":
      await installMcpServer(action.request);
      return `${action.label} added to ${action.cliLabel}.`;
    case "mcp-remove":
      await removeMcpServer({ provider_id: action.providerId, server_name: action.serverName });
      return `${action.label} removed from ${action.cliLabel}.`;
    case "mcp-update": {
      const { version } = await updateMcpServer({
        provider_id: action.providerId,
        server_name: action.serverName,
      });
      return `${action.label} updated to ${version} in ${action.cliLabel}.`;
    }
    case "skill-install":
      await installSkill({ provider_id: action.providerId, plugin_id: action.pluginId });
      return `${action.label} installed in ${action.cliLabel}. New sessions load it.`;
    case "skill-remove":
      await removeSkill({ provider_id: action.providerId, plugin_id: action.pluginId });
      return `${action.label} removed from ${action.cliLabel}.`;
    case "skill-update":
      await updateSkill({ provider_id: action.providerId, plugin_id: action.pluginId });
      return `${action.label} is up to date in ${action.cliLabel}. New sessions load it.`;
  }
}

/** The inventories `actions` can change. */
function inventoryUrls(actions: readonly AgentExtensionAction[]): string[] {
  const kinds = new Set(actions.map((action) => (action.kind.startsWith("mcp") ? "mcp" : "skill")));
  return [...kinds].map((kind) => INVENTORY_URLS[kind]);
}

interface AgentExtensionActionsValue {
  run: (action: AgentExtensionAction) => Promise<boolean>;
  /** Runs `actions` in turn, stopping at the first refusal; inventories reload once at the end. */
  runAll: (actions: readonly AgentExtensionAction[]) => Promise<void>;
  pending: ReadonlySet<string>;
  runningAll: boolean;
}

const Context = createContext<AgentExtensionActionsValue | null>(null);

/**
 * Runs CLI-backed changes above the list and detail routes, so a running
 * install (or "Update all") keeps its spinner across navigation. Nothing is
 * shown as done until the CLI confirmed it; inventories are re-read after.
 */
export function AgentExtensionActionsProvider({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const client = useQueryClient();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [runningAll, setRunningAll] = useState(false);
  /** One change; `reload` re-reads its inventory before reporting it. */
  const runOne = useCallback(
    async (action: AgentExtensionAction, reload: boolean) => {
      const key = actionKey(action);
      setPending((current) => new Set(current).add(key));
      try {
        const message = await execute(action);
        if (reload) await invalidateByUrlPrefix(client, inventoryUrls([action]));
        toast.success(message);
        return true;
      } catch (error) {
        toastError(error, `${action.label}: ${action.cliLabel} did not confirm the change.`);
        // A failed CLI run may still have changed something: re-read it.
        if (reload) await invalidateByUrlPrefix(client, inventoryUrls([action]));
        return false;
      } finally {
        setPending((current) => {
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }
    },
    [client],
  );
  const run = useCallback((action: AgentExtensionAction) => runOne(action, true), [runOne]);
  const runAll = useCallback(
    async (actions: readonly AgentExtensionAction[]) => {
      setRunningAll(true);
      try {
        for (const action of actions) if (!(await runOne(action, false))) break;
      } finally {
        await invalidateByUrlPrefix(client, inventoryUrls(actions));
        setRunningAll(false);
      }
    },
    [client, runOne],
  );
  const value = useMemo(
    () => ({ run, runAll, pending, runningAll }),
    [run, runAll, pending, runningAll],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useAgentExtensionActions(): AgentExtensionActionsValue {
  const value = useContext(Context);
  if (!value)
    throw new Error("useAgentExtensionActions must be used inside <AgentExtensionActionsProvider>");
  return value;
}

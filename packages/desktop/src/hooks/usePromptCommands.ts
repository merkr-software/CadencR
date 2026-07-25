/**
 * The `/` and `$` catalog for a provider in a directory, without a session.
 *
 * A live conversation gets this over its WebSocket (`commands.get`), which is
 * why the catalog used to be unreachable from anywhere else. Any surface that
 * composes a prompt needs it — a prompt editor that can't complete a skill is a
 * downgrade from the one next to the conversation.
 */
import { useMemo } from "react";
import { useGetPromptCommands } from "@/api/generated";
import {
  DEFAULT_PROMPT_COMMAND_POLICY,
  promptCommandPolicyFromPayload,
  type PromptCommandPolicy,
} from "@/lib/prompt-command-policy";
import type { SlashCommand } from "@/lib/slash-command";

const EMPTY_COMMANDS: SlashCommand[] = [];
// Commands are files on disk; they change when the user edits them, not while a
// dialog is open.
const STALE_MS = 60 * 1000;

export interface PromptCommandCatalog {
  commands: SlashCommand[];
  isLoading: boolean;
  policy: PromptCommandPolicy;
}

export function usePromptCommands(
  cwd: string | undefined,
  providerId: string | undefined,
): PromptCommandCatalog {
  const enabled = !!cwd && !!providerId;
  const query = useGetPromptCommands(
    { cwd: cwd ?? "", provider: providerId ?? "" },
    { query: { enabled, staleTime: STALE_MS } },
  );

  return useMemo(() => {
    const payload = query.data;
    return {
      commands: payload
        ? payload.commands.map((command) => ({
            name: command.name,
            description: command.description ?? "",
            kind: command.kind,
          }))
        : EMPTY_COMMANDS,
      isLoading: enabled && query.isLoading,
      policy: payload
        ? promptCommandPolicyFromPayload(payload.prompt_command_policy)
        : DEFAULT_PROMPT_COMMAND_POLICY,
    };
  }, [enabled, query.data, query.isLoading]);
}

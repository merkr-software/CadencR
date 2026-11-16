/** A Cadencr virtual orchestration skill uses the provider's skill trigger but
 * remains distinguishable for branded rendering and MCP availability gates. */
export type SlashCommandKind = "command" | "skill" | "cadencr";

export interface SlashCommand {
  [key: string]: unknown;
  name: string;
  description: string;
  kind: SlashCommandKind;
  argumentHint?: string;
  /** A Cadencr skill that runs inside Cadencr itself and needs no MCP server
   *  (`/cadencr:side`), so the MCP gate never disables it. */
  standalone?: boolean;
}

/** A Cadencr skill needs Cadencr's MCP tools, unless it runs on its own. */
export function isSlashCommandDisabled(
  command: SlashCommand | undefined,
  cadencrEnabled: boolean,
): boolean {
  return command?.kind === "cadencr" && !command.standalone && !cadencrEnabled;
}

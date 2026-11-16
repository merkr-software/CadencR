import type {
  PluginTabBackendBinary,
  PluginTabPendingUpdate,
  PluginTabSummary,
} from "@/api/generated";

/** What a staged update asks for that the installed version does not: marked "new". */
export interface AddedAccess {
  permissions: ReadonlySet<string>;
  origins: ReadonlySet<string>;
  /** Program names. */
  commands: ReadonlySet<string>;
  /** The update ships a native program; the installed version runs none. */
  backend: boolean;
}

/** How the update changes the native program Cadencr would start. */
export type NativeProgramChange =
  | { kind: "added"; to: PluginTabBackendBinary | null }
  | { kind: "removed" }
  | {
      kind: "changed";
      /** `null` when the installed binary's facts are unknown. */
      from: PluginTabBackendBinary | null;
      to: PluginTabBackendBinary;
    };

type Installed = Pick<
  PluginTabSummary,
  "permissions" | "network" | "commands" | "backend" | "backend_binary"
>;

function addedTo(current: readonly string[], next: readonly string[]): ReadonlySet<string> {
  const known = new Set(current);
  return new Set(next.filter((item) => !known.has(item)));
}

export function addedAccess(tab: Installed, update: PluginTabPendingUpdate): AddedAccess {
  return {
    permissions: addedTo(tab.permissions, update.permissions),
    origins: addedTo(tab.network.allowed_origins, update.network.allowed_origins),
    commands: addedTo(
      tab.commands.map((command) => command.program),
      update.commands.map((command) => command.program),
    ),
    backend: !tab.backend && !!update.backend,
  };
}

export function hasAdditions(added: AddedAccess): boolean {
  return added.backend || added.permissions.size + added.origins.size + added.commands.size > 0;
}

/** `null` when the update runs the very same program (or none, like the installed one). */
export function nativeProgramChange(
  tab: Installed,
  update: PluginTabPendingUpdate,
): NativeProgramChange | null {
  if (!update.backend) return tab.backend ? { kind: "removed" } : null;
  const to = update.backend_binary ?? null;
  if (!tab.backend) return { kind: "added", to };
  // Without the staged binary's facts nothing can be compared: say nothing rather than guess.
  if (!to) return null;
  const from = tab.backend_binary ?? null;
  if (from?.executable_sha256 === to.executable_sha256 && from.protocol === to.protocol)
    return null;
  return { kind: "changed", from, to };
}

/** The first 12 hex digits: enough to tell two builds apart at a glance. */
export function shortDigest(sha256: string): string {
  return sha256.slice(0, 12);
}

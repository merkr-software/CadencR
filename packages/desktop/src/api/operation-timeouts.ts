import type { AxiosRequestConfig } from "axios";

type TimeoutConfig = Pick<AxiosRequestConfig, "method" | "timeout" | "url">;

/**
 * Endpoints that drive long-running processes. The 30 s default is way too
 * tight for these:
 * - `/api/git/commit` fires pre-commit hooks (full test suite easily ≥ minutes).
 * - `/api/git/push` waits on remote network.
 * - `/api/lsp/sessions` may trigger a 30 MB+ rust-analyzer download on the
 *   first open in a Rust workspace. The backend has its own 5-min download
 *   timeout; the renderer just needs to not give up on the POST first.
 *
 * For these calls we disable the timeout entirely.
 */
export const NO_TIMEOUT_PATHS = ["/api/git/commit", "/api/git/push", "/api/lsp/sessions"];

const LONG_PUBLICATION_PATH =
  /^\/api\/projects\/\d+\/(?:publication-release(?:\/preview)?|publication-contribution|publication-registry(?:\/preview)?)$/;

export function publicationOperationTimeout(config: TimeoutConfig): number | undefined {
  if (config.timeout !== undefined) return config.timeout;
  const method = config.method?.toUpperCase() ?? "GET";
  return method === "POST" &&
    typeof config.url === "string" &&
    LONG_PUBLICATION_PATH.test(config.url)
    ? 190000
    : undefined;
}

// Backend permits 60 seconds for the download and 90 seconds for the complete
// conformance probe. Allow 30 seconds for bounded extraction/activation overhead.
const LONG_MANAGED_PROVIDER_PATH =
  /^\/api\/agents\/managed-providers(?:\/[^/]+\/(?:update|rollback))?$/;

export function managedProviderOperationTimeout(config: TimeoutConfig): number | undefined {
  if (config.timeout !== undefined) return config.timeout;
  return config.method?.toUpperCase() === "POST" &&
    typeof config.url === "string" &&
    LONG_MANAGED_PROVIDER_PATH.test(config.url)
    ? 180000
    : undefined;
}

const NEOVIM_STARTUP_PATH = /^\/api\/(?:neovim\/start|features\/\d+\/neovim\/open)$/;

export function neovimOperationTimeout(config: TimeoutConfig): number | undefined {
  if (config.timeout !== undefined) return config.timeout;
  // Initialization gets 90 seconds, with 10 seconds each for connecting and
  // opening. Keep the renderer's request alive until the backend can reply.
  return config.method?.toUpperCase() === "POST" &&
    typeof config.url === "string" &&
    NEOVIM_STARTUP_PATH.test(config.url)
    ? 120000
    : undefined;
}

// Skills and MCP servers install by running the agent CLIs, which fetch from
// the network (backend budget: 180 s per command; an MCP update runs four,
// a marketplace refresh then a listing two in a row). The backend finishes a
// change even when this gives up, so a timeout only loses the confirmation.
const AGENT_EXTENSION_PATH = /^\/api\/agent-extensions\//;

export function agentExtensionOperationTimeout(config: TimeoutConfig): number | undefined {
  if (config.timeout !== undefined) return config.timeout;
  if (typeof config.url !== "string" || !AGENT_EXTENSION_PATH.test(config.url)) return undefined;
  return config.method?.toUpperCase() === "POST" ? 900000 : 600000;
}

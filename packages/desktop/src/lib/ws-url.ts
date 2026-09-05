import { getAuthTokenSync, resolveApiBaseUrlSync } from "@/api/client";

export function getWsUrl(): string {
  return resolveApiBaseUrlSync().replace(/^http/, "ws") + "/ws";
}

export function getTerminalWsUrl(): string {
  return resolveApiBaseUrlSync().replace(/^http/, "ws") + "/api/terminal/ws";
}

export function getNeovimWsUrl(): string {
  return resolveApiBaseUrlSync().replace(/^http/, "ws") + "/api/neovim/ws";
}

/**
 * Subprotocol the server matches and echoes in the 101 response — the
 * browser rejects the upgrade without this round-trip.
 */
export function getWsProtocols(): string[] {
  const token = getAuthTokenSync();
  return token ? [`cadencr-token.${token}`] : [];
}

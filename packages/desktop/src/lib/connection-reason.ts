import type { UiTranslator } from "@/lib/i18n/ui";
import { formatExactNumber } from "./format-number";
import { AUTO_RECONNECT_TIMEOUT_SECONDS, WS_RATE_LIMIT_RETRY_MS } from "./ws-reconnect";

export type SocketStatusChannel = "app" | "session";

const socketStatusLabel: Record<SocketStatusChannel, (t: UiTranslator) => string> = {
  app: (t) => t("conversation.connection.appSocket", "App WebSocket"),
  session: (t) => t("conversation.connection.sessionSocket", "Session WebSocket"),
};

/** Raw diagnostics are displayed verbatim. App messages render in the current UI language. */
export type ConnectionReason =
  | string
  | {
      kind:
        | "backendUnreachable"
        | "backendTimedOut"
        | "backendRateLimited"
        | "retrying"
        | "reconnectTimeout"
        | "neovimSocketError"
        | "neovimSocketDropped"
        | "terminalSocketError"
        | "terminalSocketDropped"
        | "terminalWriteStalled";
    }
  | { kind: "httpError"; status: number; statusText: string }
  | { kind: "socketError" | "socketOverloaded" | "socketRateLimited"; channel: SocketStatusChannel }
  | { kind: "socketClosed"; channel: SocketStatusChannel; code: number | null };

export function formatConnectionReason(
  reason: ConnectionReason,
  t: UiTranslator,
  locale: string,
): string {
  if (typeof reason === "string") return reason;
  switch (reason.kind) {
    case "backendUnreachable":
      return t("conversation.connection.unreachable", "Backend unreachable");
    case "backendTimedOut":
      return t("conversation.connection.timedOut", "Backend not responding (timed out)");
    case "backendRateLimited":
      return t("conversation.connection.rateLimited", "Backend rate limit reached; backing off");
    case "retrying":
      return t("conversation.connection.retrying", "Retrying backend connection");
    case "reconnectTimeout":
      return t(
        "conversation.connection.reconnectTimeout",
        "Backend WebSocket failed to reconnect for {{count, number}} seconds",
        {
          count: AUTO_RECONNECT_TIMEOUT_SECONDS,
          defaultValue_one: "Backend WebSocket failed to reconnect for {{count, number}} second",
          formatParams: { count: { locale } },
        },
      );
    case "neovimSocketError":
      return t("workspace.editor.neovim.socketError", "Neovim WebSocket error");
    case "neovimSocketDropped":
      return t("workspace.editor.neovim.socketDropped", "Neovim WebSocket dropped");
    case "terminalSocketError":
      return t("workspace.tools.useTerminalWebSocket.socketError", "Terminal WebSocket error");
    case "terminalSocketDropped":
      return t("workspace.tools.useTerminalWebSocket.socketDropped", "Terminal WebSocket dropped");
    case "terminalWriteStalled":
      return t("workspace.tools.useTerminalWebSocket.writeStalled", "Terminal write stalled");
    case "httpError":
      return t("conversation.connection.httpError", "Backend returned {{status}} {{statusText}}", {
        status: reason.status,
        statusText: reason.statusText,
      });
    case "socketError":
      return t("conversation.connection.socketError", "{{label}} error", {
        label: socketStatusLabel[reason.channel](t),
      });
    case "socketOverloaded":
      return t("conversation.connection.socketOverloaded", "{{label}} overloaded; reconnecting", {
        label: socketStatusLabel[reason.channel](t),
      });
    case "socketRateLimited":
      return t(
        "conversation.connection.socketRateLimited",
        "{{label}} rate limited; retrying in {{seconds}}s",
        {
          label: socketStatusLabel[reason.channel](t),
          seconds: formatExactNumber(Math.ceil(WS_RATE_LIMIT_RETRY_MS / 1000), locale),
        },
      );
    case "socketClosed":
      return t("conversation.connection.socketClosed", "{{label}} closed ({{code}})", {
        label: socketStatusLabel[reason.channel](t),
        code: reason.code,
      });
  }
}

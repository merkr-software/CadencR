import { toast } from "sonner";
import { z } from "zod";

import { desktopBridge } from "@/lib/desktop-bridge";
import { isSafeExternalUrl } from "@/lib/safe-url";

import { BrokerError, badRequest, toBrokerError } from "./broker-errors";
import {
  NULL_OUTCOME,
  parseParams,
  type BrokerRuntime,
  type MethodHandler,
  type MethodOutcome,
} from "./broker-runtime";
import { hasPendingExternalOpen, requestExternalOpen, setPluginTabBadge } from "./runtime-store";

const MAX_BADGE_CHARS = 4;

const toastSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(1000).optional(),
  variant: z.enum(["default", "success", "error"]).optional(),
});

async function showToast(params: unknown, runtime: BrokerRuntime): Promise<MethodOutcome> {
  const { title, description, variant } = parseParams(toastSchema, params, "ui.toast");
  // Named after the plugin: a toast is app chrome, and the user must be able
  // to tell a tab's message from Cadencr's own.
  const message = `${runtime.plugin.name}: ${title}`;
  const options = description === undefined ? undefined : { description };
  if (variant === "success") toast.success(message, options);
  else if (variant === "error") toast.error(message, options);
  else toast(message, options);
  return NULL_OUTCOME;
}

/** Loopback or unspecified hosts (`URL.hostname` already normalizes `127.1`, `0x7f.1`, …). */
function isLocalHost(url: string): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "[::]" ||
    host === "0.0.0.0" ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

async function openExternal(params: unknown, runtime: BrokerRuntime): Promise<MethodOutcome> {
  const { url } = parseParams(z.object({ url: z.string().min(1) }), params, "ui.openExternal");
  if (!isSafeExternalUrl(url) || isLocalHost(url)) {
    throw badRequest(
      "ui.openExternal only opens https: URLs without credentials or loopback hosts",
    );
  }
  // One confirmation at a time per tab: a guest calling in a loop must not
  // queue an endless chain of dialogs.
  if (hasPendingExternalOpen(runtime.instanceId)) {
    throw new BrokerError("CAPABILITY_DENIED", "A link confirmation is already open for this tab");
  }
  const confirmed = await requestExternalOpen({
    instanceId: runtime.instanceId,
    pluginName: runtime.plugin.name,
    url,
  });
  if (!confirmed) throw new BrokerError("CAPABILITY_DENIED", "The user did not open the link");
  try {
    await desktopBridge.openExternal(url);
  } catch (error) {
    throw toBrokerError(error);
  }
  return NULL_OUTCOME;
}

async function setBadge(params: unknown, runtime: BrokerRuntime): Promise<MethodOutcome> {
  const { text } = parseParams(z.object({ text: z.string().nullable() }), params, "ui.setBadge");
  if (text !== null && [...text].length > MAX_BADGE_CHARS) {
    throw badRequest(`A tab badge holds at most ${MAX_BADGE_CHARS} characters`);
  }
  setPluginTabBadge(runtime.instanceId, text === null || text.trim() === "" ? null : text);
  return NULL_OUTCOME;
}

export const UI_METHODS: Readonly<Record<string, MethodHandler>> = {
  "ui.toast": showToast,
  "ui.openExternal": openExternal,
  "ui.setBadge": setBadge,
};

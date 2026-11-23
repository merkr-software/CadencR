import { httpBrowserOrigin } from "../../src/shared/browser-url";
import type { BrowserProfile } from "./browser-profiles";
import type { BrowserProfileMetadata, BrowserSitePermission } from "./browser-types";

export function requestPermissions(
  permission: string,
  details: Electron.PermissionRequest,
): BrowserSitePermission[] {
  if (permission === "geolocation") return ["location"];
  if (permission === "clipboard-read" || permission === "clipboard-sanitized-write") {
    return ["clipboard"];
  }
  if (permission !== "media") return [];
  const mediaTypes = (details as Electron.MediaAccessPermissionRequest).mediaTypes;
  if (!mediaTypes) return [];
  const requested: BrowserSitePermission[] = [];
  if (mediaTypes.includes("video")) requested.push("camera");
  if (mediaTypes.includes("audio")) requested.push("microphone");
  return requested;
}

export function checkPermissions(
  permission: string,
  details: Electron.PermissionCheckHandlerHandlerDetails,
): BrowserSitePermission[] {
  if (permission === "geolocation") return ["location"];
  if (permission === "clipboard-read" || permission === "clipboard-sanitized-write") {
    return ["clipboard"];
  }
  if (permission !== "media") return [];
  if (details.mediaType === "video") return ["camera"];
  if (details.mediaType === "audio") return ["microphone"];
  return [];
}

export function requestOriginIsConsistent(
  permission: string,
  details: Electron.PermissionRequest,
  origin: string,
): boolean {
  if (permission !== "media") return true;
  const securityOrigin = originOf(
    (details as Electron.MediaAccessPermissionRequest).securityOrigin ?? "",
  );
  return securityOrigin !== null && securityOrigin === origin;
}

export const originOf = httpBrowserOrigin;

export function profileMetadata(profile: BrowserProfile): BrowserProfileMetadata {
  return { id: profile.id, label: profile.label, mode: profile.mode };
}

export function decisionKey(
  partition: string,
  origin: string,
  permission: BrowserSitePermission,
): string {
  return `${partition}\n${origin}\n${permission}`;
}

export function siteKey(partition: string, origin: string): string {
  return `${partition}\n${origin}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

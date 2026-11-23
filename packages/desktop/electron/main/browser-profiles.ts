import { randomUUID } from "node:crypto";
import type { BrowserTabPrivacy } from "./browser-types";

export type BrowserProfileMode = "fresh" | "feature" | "persistent";

export interface BrowserProfile {
  id: string;
  label: string;
  mode: BrowserProfileMode;
}

export function privacyForProfileMode(mode: BrowserProfileMode): BrowserTabPrivacy {
  if (mode === "persistent") return "normal";
  return mode === "fresh" ? "private" : "feature";
}

export function privacyFromProfileId(profileId: string): BrowserTabPrivacy {
  if (profileId === "fresh") return "private";
  if (profileId === "feature") return "feature";
  return "normal";
}

export function createBrowserProfile(mode: BrowserProfileMode, id?: string): BrowserProfile {
  if (mode === "persistent") {
    const profileId = id ?? "default";
    if (!isPersistentProfileId(profileId)) throw new Error("Invalid browser profile id.");
    return { id: profileId, label: profileId, mode };
  }
  const profileId = id ?? randomUUID();
  return { id: profileId, label: mode === "fresh" ? "Fresh ephemeral" : "Feature ephemeral", mode };
}

export function isPersistentProfileId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}

export function browserPartitionForProfile(profile: BrowserProfile): string {
  if (profile.mode === "persistent") return `persist:browser:${profile.id}`;
  return `browser:${profile.mode}:${profile.id}`;
}

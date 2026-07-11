import type { AgentMessageOrigin } from "@/api/generated";

interface ParsedSessionEnvelope {
  attributes: Record<string, string>;
  body: string;
}

const ATTRIBUTE_PATTERN = /([a-z-]+)="([^"]*)"/g;

export function parseSessionEnvelope(
  content: string,
  tag: "cadencr-reply" | "cadencr-gate",
): ParsedSessionEnvelope | null {
  const pattern = new RegExp(`^<${tag}\\s+([^>]+)>\\r?\\n?([\\s\\S]*?)\\r?\\n?</${tag}>\\s*$`);
  const match = pattern.exec(content.trim());
  if (!match) return null;
  return {
    attributes: Object.fromEntries(
      Array.from(match[1].matchAll(ATTRIBUTE_PATTERN), ([, key, value]) => [key, value]),
    ),
    body: match[2],
  };
}

export function matchesGeneratedSessionOrigin(
  origin: AgentMessageOrigin | null | undefined,
  sessionId: number,
  featureId: number,
  projectId: number | undefined,
): boolean {
  if (origin?.originKind !== "session_generated" || origin.sourceSessionId !== sessionId) {
    return false;
  }
  if (origin.sourceFeatureId && origin.sourceFeatureId !== featureId) return false;
  if (origin.sourceProjectId && origin.sourceProjectId !== projectId) return false;
  return true;
}

export function decodeXmlAttribute(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

export function positiveInteger(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function optionalPositiveInteger(value: string | undefined): number | undefined {
  return value === undefined ? undefined : (positiveInteger(value) ?? undefined);
}

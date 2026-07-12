import type { RuntimeModelOption } from "@/api/agentRuntime";
import { capitalize } from "@/lib/utils";

declare const thinkingEffortLevelBrand: unique symbol;

export type ThinkingEffortLevel = string & {
  readonly [thinkingEffortLevelBrand]: true;
};

const EMPTY_THINKING_EFFORT_LEVELS: ThinkingEffortLevel[] = [];
const supportedLevelsCache = new WeakMap<string[], ThinkingEffortLevel[]>();
const effortLabelCache = new Map<ThinkingEffortLevel, string>();

/**
 * Workspace setting key for the last-used thinking effort on a given
 * provider/model pair. Mirrors the Rust helper
 * `domain::settings::thinking_effort_model_key`.
 */
export function thinkingEffortModelKey(providerId: string, modelId: string): string {
  return `thinking_effort_model_${providerId}_${modelId}`;
}

export function parseThinkingEffort(
  value: string | null | undefined,
): ThinkingEffortLevel | undefined {
  if (typeof value !== "string") return undefined;
  const effort = value.trim();
  return effort.length > 0 ? (effort as ThinkingEffortLevel) : undefined;
}

export function supportedThinkingEffortLevels(
  model: Pick<RuntimeModelOption, "supports_effort" | "supported_effort_levels"> | null | undefined,
): ThinkingEffortLevel[] {
  const advertisedLevels = model?.supported_effort_levels;
  if (!model?.supports_effort || !advertisedLevels?.length) return EMPTY_THINKING_EFFORT_LEVELS;
  const cached = supportedLevelsCache.get(advertisedLevels);
  if (cached) return cached;

  const levels: ThinkingEffortLevel[] = [];
  for (const value of advertisedLevels) {
    const effort = parseThinkingEffort(value);
    if (effort) levels.push(effort);
  }
  supportedLevelsCache.set(advertisedLevels, levels);
  return levels;
}

export function thinkingEffortLabel(effort: ThinkingEffortLevel): string {
  const cached = effortLabelCache.get(effort);
  if (cached) return cached;

  const normalized = (effort === "xhigh" ? "extra high" : effort)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
  const label = normalized.split(/\s+/).map(capitalize).join(" ");
  effortLabelCache.set(effort, label);
  return label;
}

export function isThinkingEffortSupported(
  levels: readonly ThinkingEffortLevel[],
  effort: string | null | undefined,
): effort is ThinkingEffortLevel {
  return (
    typeof effort === "string" &&
    levels.some((level: ThinkingEffortLevel): boolean => level === effort)
  );
}

export function nextThinkingEffort(
  levels: readonly ThinkingEffortLevel[],
  current: string | null | undefined,
): ThinkingEffortLevel | undefined {
  if (levels.length === 0) return undefined;
  const currentIndex = levels.findIndex((level) => level === current);
  const nextIndex = (currentIndex + 1 + levels.length) % levels.length;
  return levels[nextIndex];
}

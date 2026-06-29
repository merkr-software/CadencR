import type { Project } from "@/api/generated";
import type { UnifiedAgentsFilterMode } from "@/components/UnifiedAgentsFilters";
import type { UnifiedAgentsSortOrder } from "@/components/UnifiedAgentsFilterState";
import {
  dedupeTitles,
  firstFilterValue,
  isQuote,
  isTruthyFilterValue,
  isWhitespace,
  normalizeFilterValue,
  quoteFilterValue,
  splitFilterValues,
} from "@/components/unified-agents-filter-values";

export { quoteFilterValue } from "@/components/unified-agents-filter-values";

const UNIFIED_AGENTS_FILTER_KEYS = ["last", "project", "sort", "exclude", "pin"] as const;
export type UnifiedAgentsFilterKey = (typeof UNIFIED_AGENTS_FILTER_KEYS)[number];
const LAST_PRESETS = ["2", "5", "20", "60", "all"] as const;
const SORT_VALUES = ["created", "-created", "message", "-message"] as const;

export interface UnifiedAgentsParsedFilter {
  mode: UnifiedAgentsFilterMode;
  freshMinutes: number;
  projectIds: number[];
  excludedTitles: string[];
  /** When true, only pinned features are shown (the `/pin:` filter). */
  pinnedOnly: boolean;
  query: string;
  sortOrder: UnifiedAgentsSortOrder;
}

export interface UnifiedAgentsFilterSuggestion {
  label: string;
  detail: string;
  replacement: string;
  key: UnifiedAgentsFilterKey;
  projectId?: number;
}

export interface UnifiedAgentsFilterToken {
  text: string;
  start: number;
  end: number;
  pair: UnifiedAgentsFilterPair | null;
}

export interface UnifiedAgentsFilterPair {
  key: UnifiedAgentsFilterKey;
  value: string;
}

export const DEFAULT_UNIFIED_AGENTS_PARSED_FILTER: UnifiedAgentsParsedFilter = {
  mode: "recent",
  freshMinutes: 5,
  projectIds: [],
  excludedTitles: [],
  pinnedOnly: false,
  query: "",
  sortOrder: "created_desc",
};

export function parseUnifiedAgentsFilterText(
  text: string,
  projects: Project[],
): UnifiedAgentsParsedFilter {
  const parsed: UnifiedAgentsParsedFilter = { ...DEFAULT_UNIFIED_AGENTS_PARSED_FILTER };
  const textParts: string[] = [];
  for (const token of tokenizeFilterText(text)) {
    if (!token.pair || !applyFilterPair(parsed, token.pair, projects)) {
      addFreeTextToken(textParts, token.text);
    }
  }
  parsed.query = textParts.join(" ").trim();
  return parsed;
}

export function serializeUnifiedAgentsFilterText(
  filter: UnifiedAgentsParsedFilter,
  projects: Project[],
): string {
  const parts: string[] = [];
  if (!isDefaultLastFilter(filter)) parts.push(serializeLastFilter(filter));
  if (filter.sortOrder !== DEFAULT_UNIFIED_AGENTS_PARSED_FILTER.sortOrder) {
    parts.push(`/sort:${serializeSortValue(filter.sortOrder)}`);
  }
  if (filter.pinnedOnly) parts.push("/pin:true");
  const projectValue = serializeProjectFilter(filter.projectIds, projects);
  if (projectValue) parts.push(`/project:${projectValue}`);
  if (filter.excludedTitles.length > 0) {
    parts.push(`/exclude:${filter.excludedTitles.map(quoteFilterValue).join("|")}`);
  }
  if (filter.query.trim()) parts.push(filter.query.trim());
  return parts.join(" ");
}

export function tokenizeFilterText(text: string): UnifiedAgentsFilterToken[] {
  const tokens: UnifiedAgentsFilterToken[] = [];
  let quote: string | null = null;
  let start: number | null = null;
  for (let index = 0; index <= text.length; index += 1) {
    const char = text[index] ?? "";
    const boundary = index === text.length || (isWhitespace(char) && quote === null);
    if (boundary) {
      if (start !== null) tokens.push(createToken(text, start, index));
      start = null;
      continue;
    }
    if (start === null) start = index;
    if (isQuote(char)) quote = quote === null ? char : quote === char ? null : quote;
  }
  return tokens;
}

export function parseFilterTokenPair(token: string): UnifiedAgentsFilterPair | null {
  if (!token.startsWith("/")) return null;
  const tokenBody = token.slice(1);
  const colonIndex = tokenBody.indexOf(":");
  if (colonIndex <= 0) return null;
  const key = tokenBody.slice(0, colonIndex).toLowerCase();
  if (!isFilterKey(key)) return null;
  return { key, value: tokenBody.slice(colonIndex + 1) };
}

export function findFilterTokenAtOffset(
  text: string,
  offset: number,
): UnifiedAgentsFilterToken | null {
  const clampedOffset = Math.max(0, Math.min(text.length, offset));
  if (isWhitespace(text[clampedOffset] ?? "") || isWhitespace(text[clampedOffset - 1] ?? "")) {
    return null;
  }
  return (
    tokenizeFilterText(text).find(
      (token: UnifiedAgentsFilterToken): boolean =>
        clampedOffset >= token.start && clampedOffset <= token.end,
    ) ?? null
  );
}

export function replaceFilterToken(
  text: string,
  token: UnifiedAgentsFilterToken,
  replacement: string,
): { text: string; cursorOffset: number } {
  const prefix = text.slice(0, token.start);
  const suffix = text.slice(token.end);
  const space = replacement.endsWith(":") || /^\s/.test(suffix) ? "" : " ";
  return {
    text: `${prefix}${replacement}${space}${suffix}`,
    cursorOffset: prefix.length + replacement.length + space.length,
  };
}

export function getUnifiedAgentsFilterSuggestions(
  tokenText: string,
  projects: Project[],
): UnifiedAgentsFilterSuggestion[] {
  const pair = parseFilterTokenPair(tokenText);
  if (!tokenText.startsWith("/")) return [];
  if (!pair) return getKeySuggestions(tokenText.slice(1));
  if (pair.key === "last") return getLastSuggestions(pair.value);
  if (pair.key === "sort") return getSortSuggestions(pair.value);
  if (pair.key === "pin") return getPinSuggestions(pair.value);
  if (pair.key === "project") return getProjectSuggestions(pair.value, projects);
  return [];
}

export function getUnifiedAgentsFilterTokenKey(tokenText: string): UnifiedAgentsFilterKey | null {
  const pair = parseFilterTokenPair(tokenText);
  if (!pair || normalizeFilterValue(pair.value).length === 0) return null;
  return pair.key;
}

function createToken(text: string, start: number, end: number): UnifiedAgentsFilterToken {
  const tokenText = text.slice(start, end);
  return { text: tokenText, start, end, pair: parseFilterTokenPair(tokenText) };
}

function applyFilterPair(
  parsed: UnifiedAgentsParsedFilter,
  pair: UnifiedAgentsFilterPair,
  projects: Project[],
): boolean {
  if (pair.key === "last") return applyLastFilter(parsed, pair.value);
  if (pair.key === "project") {
    parsed.projectIds = resolveProjectValues(pair.value, projects);
    return true;
  }
  if (pair.key === "exclude") {
    parsed.excludedTitles = dedupeTitles(splitFilterValues(pair.value), normalizeFilterValue);
    return true;
  }
  if (pair.key === "pin") {
    parsed.pinnedOnly = isTruthyFilterValue(firstFilterValue(pair.value));
    return true;
  }
  const sortOrder = parseSortValue(firstFilterValue(pair.value));
  if (sortOrder) parsed.sortOrder = sortOrder;
  return true;
}

function applyLastFilter(parsed: UnifiedAgentsParsedFilter, value: string): boolean {
  const next = parseLastValue(firstFilterValue(value));
  if (!next) return true;
  parsed.mode = next.mode;
  parsed.freshMinutes = next.freshMinutes;
  return true;
}

function parseLastValue(
  value: string,
): Pick<UnifiedAgentsParsedFilter, "mode" | "freshMinutes"> | null {
  const normalized = normalizeFilterValue(value).toLowerCase();
  if (normalized === "" || normalized === "all") {
    return normalized === "all" ? { mode: "all", freshMinutes: 5 } : null;
  }
  const match = /^(\d+)(m|min|minute|minutes|h|hour|hours)?$/.exec(normalized);
  if (!match) return null;
  const amount = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(amount) || amount < 1) return null;
  const multiplier = match[2]?.startsWith("h") ? 60 : 1;
  return { mode: "recent", freshMinutes: amount * multiplier };
}

function isDefaultLastFilter(filter: UnifiedAgentsParsedFilter): boolean {
  return (
    filter.mode === DEFAULT_UNIFIED_AGENTS_PARSED_FILTER.mode &&
    filter.freshMinutes === DEFAULT_UNIFIED_AGENTS_PARSED_FILTER.freshMinutes
  );
}

function parseSortValue(value: string): UnifiedAgentsSortOrder | null {
  const normalized = normalizeFilterValue(value).toLowerCase();
  const ascending = normalized.startsWith("-");
  const sortName = ascending ? normalized.slice(1) : normalized;
  if (["created", "creation", "date"].includes(sortName)) {
    return ascending ? "created_asc" : "created_desc";
  }
  if (["message", "activity", "last", "recent"].includes(sortName)) {
    return ascending ? "activity_asc" : "activity_desc";
  }
  return null;
}

function resolveProjectValues(value: string, projects: Project[]): number[] {
  const ids: number[] = [];
  for (const part of splitFilterValues(value)) {
    const project = resolveProject(normalizeFilterValue(part), projects);
    if (project && !ids.includes(project.id)) ids.push(project.id);
  }
  return ids;
}

function resolveProject(value: string, projects: Project[]): Project | null {
  if (!value || value.toLowerCase() === "all") return null;
  const numericId = Number.parseInt(value, 10);
  return (
    projects.find(
      (project: Project): boolean => project.name.toLowerCase() === value.toLowerCase(),
    ) ??
    projects.find(
      (project: Project): boolean => Number.isFinite(numericId) && project.id === numericId,
    ) ??
    null
  );
}

function serializeLastFilter(filter: UnifiedAgentsParsedFilter): string {
  return filter.mode === "all" ? "/last:all" : `/last:${filter.freshMinutes}`;
}

function serializeSortValue(sortOrder: UnifiedAgentsSortOrder): string {
  if (sortOrder === "created_asc") return "-created";
  if (sortOrder === "activity_desc") return "message";
  if (sortOrder === "activity_asc") return "-message";
  return "created";
}

function serializeProjectFilter(projectIds: number[], projects: Project[]): string {
  return projectIds
    .map((projectId: number): string => quoteFilterValue(projectNameOrId(projectId, projects)))
    .join("|");
}

function projectNameOrId(projectId: number, projects: Project[]): string {
  return (
    projects.find((project: Project): boolean => project.id === projectId)?.name ??
    String(projectId)
  );
}

function addFreeTextToken(textParts: string[], token: string): void {
  if (!token || token.endsWith(":")) return;
  textParts.push(token);
}

function getKeySuggestions(token: string): UnifiedAgentsFilterSuggestion[] {
  const normalized = token.toLowerCase();
  return UNIFIED_AGENTS_FILTER_KEYS.filter((key: string): boolean =>
    key.startsWith(normalized),
  ).map(
    (key: UnifiedAgentsFilterKey): UnifiedAgentsFilterSuggestion => ({
      label: `/${key}:`,
      detail: keySuggestionDetail(key),
      replacement: `/${key}:`,
      key,
    }),
  );
}

function getLastSuggestions(value: string): UnifiedAgentsFilterSuggestion[] {
  return LAST_PRESETS.filter((preset: string): boolean =>
    preset.startsWith(normalizeFilterValue(value)),
  ).map(
    (preset: string): UnifiedAgentsFilterSuggestion => ({
      label: `/last:${preset}`,
      detail: preset === "all" ? "All agents" : `Last ${preset} minutes`,
      replacement: `/last:${preset}`,
      key: "last",
    }),
  );
}

function getSortSuggestions(value: string): UnifiedAgentsFilterSuggestion[] {
  const normalized = normalizeFilterValue(value).toLowerCase();
  return SORT_VALUES.filter((sortValue: string): boolean => sortValue.startsWith(normalized)).map(
    (sortValue: string): UnifiedAgentsFilterSuggestion => ({
      label: `/sort:${sortValue}`,
      detail: sortValue.startsWith("-") ? "Ascending order" : "Descending order",
      replacement: `/sort:${sortValue}`,
      key: "sort",
    }),
  );
}

function getPinSuggestions(value: string): UnifiedAgentsFilterSuggestion[] {
  return ["true"]
    .filter((preset: string): boolean =>
      preset.startsWith(normalizeFilterValue(value).toLowerCase()),
    )
    .map(
      (preset: string): UnifiedAgentsFilterSuggestion => ({
        label: `/pin:${preset}`,
        detail: "Only pinned agents",
        replacement: `/pin:${preset}`,
        key: "pin",
      }),
    );
}

function getProjectSuggestions(
  value: string,
  projects: Project[],
): UnifiedAgentsFilterSuggestion[] {
  const prefix = value.slice(0, value.lastIndexOf("|") + 1);
  const currentValue = normalizeFilterValue(value.slice(prefix.length)).toLowerCase();
  return projects
    .filter((project: Project): boolean => project.name.toLowerCase().includes(currentValue))
    .slice(0, 8)
    .map(
      (project: Project): UnifiedAgentsFilterSuggestion => ({
        label: project.name,
        detail: project.path,
        replacement: `/project:${prefix}${quoteFilterValue(project.name)}`,
        key: "project",
        projectId: project.id,
      }),
    );
}

function keySuggestionDetail(key: UnifiedAgentsFilterKey): string {
  if (key === "last") return "Activity window";
  if (key === "project") return "Project";
  if (key === "exclude") return "Hide agents by name";
  if (key === "pin") return "Only pinned agents";
  return "Sort order";
}

function isFilterKey(key: string): key is UnifiedAgentsFilterKey {
  return UNIFIED_AGENTS_FILTER_KEYS.includes(key as UnifiedAgentsFilterKey);
}

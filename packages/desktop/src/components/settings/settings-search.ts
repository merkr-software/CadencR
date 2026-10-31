import { foldText, queryTokens, type MatchRange } from "@/lib/command-palette/palette-score";
import {
  SETTINGS_NAV_GROUPS,
  type SettingsEntry,
  type SettingsNavGroup,
  type SettingsPageMeta,
} from "./settings-catalog";

export interface SettingsSearchPageResult {
  page: SettingsPageMeta;
  /** Whether the page's own name matched. */
  pageMatched: boolean;
  /** The page's settings that matched; empty when only the page did. */
  entries: readonly SettingsEntry[];
}

export interface SettingsSearchGroupResult {
  label: string;
  pages: readonly SettingsSearchPageResult[];
}

/** Every word of the query must appear somewhere in the haystack, accent- and case-blind. */
function matchesAll(words: readonly string[], haystack: readonly string[]): boolean {
  const folded = haystack.map(foldText);
  return words.every((word) => folded.some((text) => text.includes(word)));
}

/**
 * Filters the rail down to what matches `query`, keeping the rail's groups and
 * order so results read like the navigation they come from.
 *
 * A page matches on its name or a retired section's name ("interface" finds
 * General); a page that matches keeps every entry hidden, since the page itself
 * is the answer. Otherwise a setting matches on its label, its keywords and
 * its page's name, so "editor vim" finds Vim mode.
 */
export function searchSettings(
  query: string,
  groups: readonly SettingsNavGroup[] = SETTINGS_NAV_GROUPS,
): SettingsSearchGroupResult[] {
  const words = queryTokens(query);
  if (words.length === 0) return [];
  return groups
    .map((group) => ({
      label: group.label,
      pages: group.pages.flatMap((page): SettingsSearchPageResult[] => {
        const pageMatched = matchesAll(words, [page.label, ...(page.aliases ?? [])]);
        if (pageMatched) return [{ page, pageMatched, entries: [] }];
        const entries = page.entries.filter((entry) =>
          matchesAll(words, [entry.label, page.label, ...(entry.keywords ?? [])]),
        );
        return entries.length > 0 ? [{ page, pageMatched, entries }] : [];
      }),
    }))
    .filter((group) => group.pages.length > 0);
}

/** The `?section=` value the first result opens, for Enter in the search field. */
export function firstSearchTarget(results: readonly SettingsSearchGroupResult[]): string | null {
  const first = results[0]?.pages[0];
  if (!first) return null;
  return first.entries[0]?.anchor ?? first.page.id;
}

/**
 * Where the query's words occur in `text`, merged and in order, so the rail
 * can emphasize what matched. `foldText` keeps one character per UTF-16 unit,
 * so an offset in the folded text is an offset in `text`.
 */
export function highlightRanges(text: string, query: string): MatchRange[] {
  const words = queryTokens(query);
  const folded = foldText(text);
  const marks = new Array<boolean>(text.length).fill(false);
  for (const word of words) {
    let from = folded.indexOf(word);
    while (from !== -1) {
      marks.fill(true, from, from + word.length);
      from = folded.indexOf(word, from + word.length);
    }
  }
  const ranges: MatchRange[] = [];
  let start = -1;
  for (let index = 0; index <= text.length; index += 1) {
    if (marks[index] && start === -1) start = index;
    else if (!marks[index] && start !== -1) {
      ranges.push([start, index]);
      start = -1;
    }
  }
  return ranges;
}

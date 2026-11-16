import { Fragment, type ReactElement, type ReactNode } from "react";
import type { MatchRange } from "@/lib/command-palette/palette-score";
import { KbdKeyContent } from "@/components/kbd-key";
import { formatCombo, PLATFORM_IS_MAC } from "@/lib/shortcuts/format";
import { useResolvedShortcut } from "@/lib/shortcuts/overrides";
import type { ShortcutId } from "@/lib/shortcuts/registry";

/** `text` with the matched ranges set in full contrast and weight. */
export function HighlightedText({
  text,
  ranges,
}: {
  text: string;
  ranges: readonly MatchRange[];
}): ReactNode {
  if (ranges.length === 0) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) parts.push(text.slice(cursor, start));
    parts.push(
      <span key={start} className="cp-hl">
        {text.slice(start, end)}
      </span>,
    );
    cursor = end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/** `positions` (single matched characters, as the file search returns them) as ranges. */
export function positionsToRanges(positions: readonly number[], offset = 0): MatchRange[] {
  const ranges: [number, number][] = [];
  for (const position of [...positions].sort((a, b) => a - b)) {
    const at = position - offset;
    if (at < 0) continue;
    const last = ranges.at(-1);
    if (last && last[1] === at) last[1] = at + 1;
    else ranges.push([at, at + 1]);
  }
  return ranges;
}

const MARK_START = "\u0002";
const MARK_END = "\u0003";

/** A server snippet as plain text: markers dropped, whitespace folded. */
export function snippetPlainText(snippet: string): string {
  return snippet.split(MARK_START).join("").split(MARK_END).join("").replace(/\s+/g, " ").trim();
}

/** A server snippet with its U+0002…U+0003 markers rendered as `<mark>`, on one line. */
export function SnippetText({ snippet }: { snippet: string }): ReactElement {
  const flat = snippet.replace(/\s+/g, " ").trim();
  const pieces = flat.split(MARK_START);
  return (
    <span className="cp-snippet">
      {pieces.map((piece, index) => {
        if (index === 0) return <Fragment key={index}>{piece}</Fragment>;
        const [marked = "", rest = ""] = piece.split(MARK_END);
        return (
          <Fragment key={index}>
            <mark>{marked}</mark>
            {rest}
          </Fragment>
        );
      })}
    </span>
  );
}

/** The live binding of `id`, as key caps. */
export function PaletteKeys({ id }: { id: ShortcutId }): ReactElement {
  const { keys } = useResolvedShortcut(id);
  return <KeyCaps keys={formatCombo(keys)} />;
}

export function KeyCaps({ keys }: { keys: readonly string[] }): ReactElement {
  return (
    <span className="cp-keys" aria-hidden>
      {keys.map((key, index) => (
        <ComboCap key={`${key}-${index}`} keys={[key]} />
      ))}
    </span>
  );
}

/** One cap for a whole combo (`⌥S`); keys render through the shared glyph logic. */
export function ComboCap({ keys }: { keys: readonly string[] }): ReactElement {
  return (
    <kbd className="cp-key">
      {keys.map((key, index) => (
        <KbdKeyContent key={`${key}-${index}`} keyName={key} isMac={PLATFORM_IS_MAC} />
      ))}
    </kbd>
  );
}

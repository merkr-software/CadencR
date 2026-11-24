import type { ReactElement } from "react";
import { Maximize2Icon } from "lucide-react";
import { HEADER_BUTTON_CLASS } from "@/components/CodeBlockHeader";

/**
 * The phone layout's rich blocks in a message (a wide table, a wide code
 * block, a diagram): a clipped preview that never scrolls inside the
 * transcript, faded where it is cut, and an Expand control opening
 * the full-screen viewer (`RichContentViewerHost`).
 */

/** What a preview fades into: the page under a bare table, or a code card's fill. */
type FadeTone = "page" | "card";

const FADE_TO: Record<FadeTone, string> = {
  page: "var(--background)",
  card: "color-mix(in oklab, var(--muted) 50%, var(--background))",
};

/** The fade over a preview's cut edges; it takes no taps. */
export function RichPreviewFade({
  wide = false,
  tall = true,
  tone = "card",
}: {
  wide?: boolean;
  tall?: boolean;
  tone?: FadeTone;
}): ReactElement {
  const to = FADE_TO[tone];
  return (
    <>
      {wide && (
        <span
          aria-hidden
          data-rich-fade="right"
          className="pointer-events-none absolute inset-y-0 right-0 w-10"
          style={{ background: `linear-gradient(to right, transparent, ${to})` }}
        />
      )}
      {tall && (
        <span
          aria-hidden
          data-rich-fade="bottom"
          className="pointer-events-none absolute inset-x-0 bottom-0 h-12"
          style={{ background: `linear-gradient(to bottom, transparent, ${to})` }}
        />
      )}
    </>
  );
}

/**
 * Expand, in a code block's header row: its text button look, a 44px target
 * on the phone layout (`CodeBlockHeader` makes the row 44px tall there).
 */
export function RichExpandButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}): ReactElement {
  return (
    <button type="button" onClick={onClick} aria-label={label} className={HEADER_BUTTON_CLASS}>
      <Maximize2Icon className="size-3" aria-hidden />
      <span>Expand</span>
    </button>
  );
}

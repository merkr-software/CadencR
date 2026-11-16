import { cn } from "@/lib/utils";

/**
 * Prose scale for markdown a forge hosts: pull request descriptions and review
 * comments, in the PR pane and on the diff rows they annotate.
 *
 * The shared `Markdown` overrides are tuned for the agent stream — `text-2xl`
 * headings, one accent colour per level, an italic comment-coloured quote. In a
 * 13px review card that turned a bot's "Confidence Score" heading into the
 * loudest thing on the pane. This puts it back on a document scale: headings a
 * step above the body and always below the PR title (16px), in the body's own
 * colour.
 *
 * Every rule is a descendant variant on the wrapper (`.x h1` beats the
 * override's bare `.text-2xl`), so the cached markdown tree is untouched. Colour
 * is `inherit` rather than `foreground` because the diff annotation sits on the
 * editor palette and sets its own text colour on the wrapper. No first/last
 * child margin reset is needed: Streamdown's own root already zeroes both, at a
 * higher specificity than these.
 */
export const PR_MARKDOWN_CLASS = cn(
  "text-[13px] leading-relaxed",
  "[&_:is(h1,h2,h3,h4,h5,h6)]:mt-3 [&_:is(h1,h2,h3,h4,h5,h6)]:mb-1 [&_:is(h1,h2,h3,h4,h5,h6)]:leading-snug",
  "[&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_:is(h1,h2,h3,h4,h5,h6)]:text-inherit",
  "[&_h1]:text-[14px] [&_h2]:text-[13.5px] [&_:is(h3,h4,h5,h6)]:text-[13px]",
  "[&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li>ul]:my-0.5 [&_li>ol]:my-0.5",
  // Streamdown spaces unstyled blocks 1rem apart; bot reviews lean on <details>.
  // Their <summary> often wraps a heading, which as a block strands the
  // disclosure marker on a line of its own; GitHub keeps the two on one line.
  // `!` because the heading margins above carry the same specificity.
  "[&_details]:my-1.5 [&_summary]:cursor-pointer [&_summary>*]:inline [&_summary>*]:!my-0",
  "[&_table]:text-[12px]",
  "[&_blockquote]:my-1.5 [&_blockquote]:border-muted-foreground/35 [&_blockquote]:text-muted-foreground [&_blockquote]:not-italic",
  "[&_hr]:my-2",
  // Inline code in the body's own colour on a faint tint of it. The stream's
  // pink chips were the most saturated thing in a review — louder than the
  // red, amber and green that carry this pane's actual state. `current`
  // rather than `foreground` keeps it right on the editor-palette annotation.
  "[&_:not(pre)>code]:bg-current/[0.08] [&_:not(pre)>code]:text-inherit",
  // Bots write badge links back to back (`</a><a>`) and float them right on
  // GitHub; inline here, they would touch each other and the heading after.
  // `data-image-link` rather than `:has(img)`: a deferred badge is a button.
  "[&_a[data-image-link]]:mr-1",
);

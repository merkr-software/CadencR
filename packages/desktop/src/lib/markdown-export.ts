import { translateUi } from "./i18n/ui";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api-errors";

/** Supported clipboard export formats for markdown sources. */
export type ExportFormat = "email" | "markdown" | "plain" | "slack";

/**
 * Strip markdown syntax to produce plain text suitable for non-markdown
 * targets (system clipboard receivers without markdown rendering).
 *
 * The input is treated as Github-flavored markdown. The transformations are
 * intentionally simple line-by-line rewrites; full mdast parsing is overkill
 * for clipboard-quality output.
 */
export function toPlainText(md: string): string {
  let out = md;
  // Fenced code blocks: keep content, drop fences.
  out = out.replace(/^```[^\n]*\n([\s\S]*?)\n```$/gm, "$1");
  // Inline code: drop backticks.
  out = out.replace(/`([^`]+)`/g, "$1");
  // Images: replace with alt text.
  out = out.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1");
  // Links: keep text, drop URL.
  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  // Headings: drop leading hashes.
  out = out.replace(/^#{1,6}\s+/gm, "");
  // Blockquotes.
  out = out.replace(/^>\s?/gm, "");
  // Horizontal rules.
  out = out.replace(/^[-*_]{3,}\s*$/gm, "");
  // List bullets.
  out = out.replace(/^(\s*)[-*+]\s+/gm, "$1");
  out = out.replace(/^(\s*)\d+\.\s+/gm, "$1");
  // Bold + italic.
  out = out.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");
  out = out.replace(/\*([^*]+)\*/g, "$1");
  out = out.replace(/_([^_]+)_/g, "$1");
  // Strikethrough.
  out = out.replace(/~~([^~]+)~~/g, "$1");
  return out;
}

/**
 * Convert standard markdown to Slack `mrkdwn` flavor.
 *
 * Slack uses a deliberately small subset:
 *   - `*bold*` (single asterisks)
 *   - `_italic_`
 *   - `~strike~`
 *   - `<url|text>` for links
 *   - no headings (we bolden them)
 *   - bullets via `•`
 *   - fenced + inline code unchanged
 *
 * https://api.slack.com/reference/surfaces/formatting#basic-formatting
 */
export function toSlackMrkdwn(md: string): string {
  let out = md;
  // 1. Convert italics first (single-asterisk and underscore) to a sentinel.
  //    We must do this BEFORE collapsing `**bold**` → `*bold*` because the
  //    output of the bold conversion would otherwise be re-matched as italic.
  //    Slack italics use underscores in the final output. The sentinel uses
  //    SOH (U+0001) bookends around "ITAL" so user text can't collide with it.
  const ITAL = "ITAL";
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, `$1${ITAL}$2${ITAL}`);
  out = out.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, `$1${ITAL}$2${ITAL}`);
  // 2. Bold → single asterisk.
  out = out.replace(/\*\*([^*]+)\*\*/g, "*$1*");
  out = out.replace(/__([^_]+)__/g, "*$1*");
  // 3. Headings → bold (Slack has no headings).
  out = out.replace(/^#{1,6}\s+(.*)$/gm, "*$1*");
  // 4. Restore italics as underscores.
  const italRe = new RegExp(ITAL, "g");
  out = out.replace(italRe, "_");
  // 5. Strikethrough.
  out = out.replace(/~~([^~]+)~~/g, "~$1~");
  // 6. Links.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
  // Unordered bullets: keep `-` and `+` as-is (Slack supports `-` lists
  // natively in its compose box). Convert `*` bullets to `-` so they don't
  // get re-interpreted as bold.
  out = out.replace(/^(\s*)\*\s+/gm, "$1- ");
  // Collapse blank lines between consecutive list items. GFM allows "loose"
  // lists with blank-line separators, but Slack's compose box treats each
  // separated line as its own paragraph — breaking the visual list. Tighten
  // them so Slack renders a single contiguous bulleted/numbered list.
  // The lookbehind/lookahead match the boundary itself without consuming
  // either list line, so a single global pass collapses chains.
  out = out.replace(
    /(?<=(?:^|\n)[ \t]*(?:[-+]|\d+\.)[ \t]+[^\n]*)\n{2,}(?=[ \t]*(?:[-+]|\d+\.)[ \t]+)/g,
    "\n",
  );
  return out;
}

/**
 * Convert markdown source to the requested format and write to the system
 * clipboard. On success shows a sonner toast; on failure surfaces the error
 * (per `error-handling.md` rule). Email writes both HTML and plain-text MIME
 * representations; the other formats deliberately remain plain text.
 */
export async function copyAs(
  format: ExportFormat,
  source: string,
  emailHtml?: string,
): Promise<void> {
  try {
    if (format === "email") {
      await writeEmailClipboard(source, emailHtml);
      toast.success(formatLabel(format));
      return;
    }
    const payload =
      format === "plain"
        ? toPlainText(source)
        : format === "slack"
          ? toSlackMrkdwn(source)
          : source;
    // For Slack we deliberately write plain text only — never HTML. Slack's
    // own formatting docs say lists are "regular text and line breaks"
    // (e.g. `- item\n- item`); a `text/html` payload makes Slack's compose
    // box treat each line as a styled paragraph and strips the bullet
    // markers. Plain text lets `*bold*`, `_italic_`, `~strike~`, `> quote`,
    // `\n- item`, fenced code, etc. render natively on paste.
    //   https://api.slack.com/reference/surfaces/formatting
    await navigator.clipboard.writeText(payload);
    toast.success(formatLabel(format));
  } catch (error: unknown) {
    const message = apiErrorMessage(error, String(error));
    console.error("[markdown-export] copy failed", error);
    toast.error(
      translateUi("clipboard.exportFailed", "Failed to copy to clipboard: {{message}}", {
        message,
      }),
    );
  }
}

async function writeEmailClipboard(source: string, html: string | undefined): Promise<void> {
  if (!html)
    throw new Error(
      translateUi("clipboard.noHtml", "No rich HTML was available for the selection"),
    );
  const item = new ClipboardItem({
    "text/html": new Blob([html], { type: "text/html" }),
    "text/plain": new Blob([toPlainText(source)], { type: "text/plain" }),
  });
  await navigator.clipboard.write([item]);
}

function formatLabel(format: ExportFormat): string {
  switch (format) {
    case "email":
      return translateUi("clipboard.copiedEmail", "Copied for email");
    case "markdown":
      return translateUi("clipboard.copiedMarkdown", "Copied as Markdown");
    case "slack":
      return translateUi("clipboard.copiedSlack", "Copied as Slack mrkdwn");
    case "plain":
      return translateUi("clipboard.copiedPlain", "Copied as plain text");
  }
}

/**
 * Reconstruct GitHub-flavored markdown from a selected DOM fragment.
 *
 * `Selection.toString()` only yields rendered visible text — list bullets,
 * heading hashes, code fences, link URLs, emphasis markers all vanish.
 * For "Copy" actions we want to preserve those, so we walk the cloned
 * `Range` fragment and re-emit markdown for each tag we recognize.
 *
 * Coverage matches the tag set produced by `<Markdown>` (Streamdown's
 * GFM pipeline): headings, paragraphs, lists, blockquote, code (inline +
 * fenced), links, emphasis, strong, strikethrough, horizontal rule, line
 * break. Tables collapse to a tab-separated approximation. Anything not
 * recognized falls through to its inner text.
 */

const HEADING_TAGS: Readonly<Record<string, string>> = {
  h1: "# ",
  h2: "## ",
  h3: "### ",
  h4: "#### ",
  h5: "##### ",
  h6: "###### ",
};

interface WalkContext {
  /** Stack of ancestor list types (`ul` / `ol`) to determine `<li>` markers. */
  listStack: Array<"ul" | "ol">;
  /** Per-list counters for ordered lists, indexed against `listStack`. */
  orderedCounter: number[];
}

export interface SelectionSnapshot {
  ranges: Range[];
  text: string;
}

function newContext(): WalkContext {
  return { listStack: [], orderedCounter: [] };
}

/**
 * Convert a selection's cloned fragment to markdown source.
 * `range.cloneContents()` produces a `DocumentFragment` already trimmed to
 * the user's selection, including partial elements at the edges — those
 * partial elements still render correctly because the walker is purely
 * structural.
 */
export function fragmentToMarkdown(fragment: DocumentFragment): string {
  const ctx = newContext();
  // Collapse runs of 3+ blank lines (from nested block emitters) to 2,
  // then trim leading/trailing whitespace.
  // Word joiners (U+2060) only keep a decoration on its label's line (link
  // marks, project badges): never part of the copied text.
  return walkChildren(fragment, ctx)
    .replaceAll("\u2060", "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Snapshot a live selection before a context menu can collapse it. */
export function captureSelectionSnapshot(selection: Selection): SelectionSnapshot {
  const ranges: Range[] = [];
  for (let index = 0; index < selection.rangeCount; index++) {
    ranges.push(selection.getRangeAt(index).cloneRange());
  }
  return { ranges, text: selection.toString() };
}

/** Rebuild Markdown lazily from a previously captured selection. */
export function selectionSnapshotToMarkdown(selection: SelectionSnapshot): string {
  let markdown = "";
  for (const range of selection.ranges) markdown += fragmentToMarkdown(range.cloneContents());
  return markdown || selection.text;
}

/** Walk every child node of `parent`, concatenating their markdown output. */
function walkChildren(parent: ParentNode, ctx: WalkContext): string {
  let out = "";
  for (let n = parent.firstChild; n !== null; n = n.nextSibling) out += walk(n, ctx);
  return out;
}

function walk(node: Node, ctx: WalkContext): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  return renderElement(tag, el, ctx);
}

function renderElement(tag: string, el: Element, ctx: WalkContext): string {
  // Inline formatting first — these can appear nested inside everything.
  if (tag === "strong" || tag === "b") return `**${walkChildren(el, ctx)}**`;
  if (tag === "em" || tag === "i") return `*${walkChildren(el, ctx)}*`;
  if (tag === "del" || tag === "s" || tag === "strike") return `~~${walkChildren(el, ctx)}~~`;
  if (tag === "a") return renderLink(el, ctx);
  if (tag === "code") return renderCode(el, ctx);
  if (tag === "pre") return renderPre(el);
  if (tag === "br") return "\n";

  // Block-level elements.
  if (tag in HEADING_TAGS) return `${HEADING_TAGS[tag]}${walkChildren(el, ctx)}\n\n`;
  if (tag === "p") return `${walkChildren(el, ctx)}\n\n`;
  if (tag === "blockquote") return renderBlockquote(el, ctx);
  if (tag === "hr") return "\n---\n\n";
  if (tag === "ul" || tag === "ol") return renderList(tag, el, ctx);
  if (tag === "li") return renderListItem(el, ctx);
  if (tag === "table") return `${walkChildren(el, ctx)}\n`;
  if (tag === "tr") return `${renderRow(el, ctx)}\n`;
  if (tag === "th" || tag === "td") return walkChildren(el, ctx);

  // Default: pass through children.
  return walkChildren(el, ctx);
}

function renderLink(el: Element, ctx: WalkContext): string {
  const href = el.getAttribute("href") ?? "";
  const text = walkChildren(el, ctx);
  if (!href) return text;
  return `[${text}](${href})`;
}

/** Inline `<code>`; fenced code blocks are handled by `renderPre`. */
function renderCode(el: Element, ctx: WalkContext): string {
  if (el.parentElement?.tagName.toLowerCase() === "pre") {
    return walkChildren(el, ctx);
  }
  return `\`${walkChildren(el, ctx)}\``;
}

function renderPre(el: Element): string {
  // Use textContent so syntax-highlighted spans collapse back to source.
  const code = (el.textContent ?? "").replace(/\n+$/, "");
  return `\n\`\`\`\n${code}\n\`\`\`\n\n`;
}

function renderBlockquote(el: Element, ctx: WalkContext): string {
  const inner = walkChildren(el, ctx).replace(/\n+$/, "");
  const quoted = inner
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
  return `${quoted}\n\n`;
}

function renderList(tag: "ul" | "ol", el: Element, ctx: WalkContext): string {
  ctx.listStack.push(tag);
  ctx.orderedCounter.push(0);
  const inner = walkChildren(el, ctx);
  ctx.listStack.pop();
  ctx.orderedCounter.pop();
  // Nested lists need a leading newline so they don't run on with the
  // parent `<li>`'s text; top-level lists get a trailing blank line so
  // following blocks are visually separated.
  const isNested = ctx.listStack.length > 0;
  const prefix = isNested ? "\n" : "";
  const trailing = isNested ? "" : "\n";
  return `${prefix}${inner}${trailing}`;
}

function renderListItem(el: Element, ctx: WalkContext): string {
  const depth = Math.max(0, ctx.listStack.length - 1);
  const indent = "  ".repeat(depth);
  const listType = ctx.listStack[ctx.listStack.length - 1] ?? "ul";
  let marker: string;
  if (listType === "ol") {
    const idx = ctx.orderedCounter.length - 1;
    ctx.orderedCounter[idx] = (ctx.orderedCounter[idx] ?? 0) + 1;
    marker = `${ctx.orderedCounter[idx]}. `;
  } else {
    marker = "- ";
  }
  // Children render with the current list context, so any nested list emits
  // its own depth-aware indent — we don't re-indent here.
  const inner = walkChildren(el, ctx).replace(/\n+$/, "");
  return `${indent}${marker}${inner}\n`;
}

function renderRow(el: Element, ctx: WalkContext): string {
  const cells = Array.from(el.children).map((c) => walkChildren(c, ctx).trim());
  return `| ${cells.join(" | ")} |`;
}

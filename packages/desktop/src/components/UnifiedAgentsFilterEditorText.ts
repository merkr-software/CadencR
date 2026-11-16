import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $setSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  TextNode,
  type LexicalEditor,
  type LexicalNode,
  type RangeSelection,
} from "lexical";
import {
  findFilterTokenAtOffset,
  getUnifiedAgentsFilterTokenKey,
  replaceFilterToken,
  tokenizeFilterText,
  type UnifiedAgentsFilterKey,
} from "@/components/UnifiedAgentsFilterLanguage";

const FILTER_TOKEN_STYLE_MARKER = "--unified-agents-filter-token:1";

export interface UnifiedAgentsFilterActiveToken {
  text: string;
  start: number;
  end: number;
}

interface UnifiedAgentsFilterEditorWriteOptions {
  cursorOffset?: number;
  selection?: "end" | "none";
}

export function getUnifiedAgentsFilterEditorText(): string {
  const root = $getRoot();
  const children = root.getChildren();
  if (children.length === 0) return "";
  return children.map((child: LexicalNode): string => child.getTextContent()).join("\n");
}

export function initializeUnifiedAgentsFilterEditorText(text: string): void {
  writeUnifiedAgentsFilterEditorText(text, { selection: "end" });
}

export function setUnifiedAgentsFilterEditorText(
  editor: LexicalEditor,
  text: string,
  options: UnifiedAgentsFilterEditorWriteOptions = {},
): void {
  editor.update(() => writeUnifiedAgentsFilterEditorText(text, options));
}

function isUnifiedAgentsFilterTokenTextNode(node: TextNode): boolean {
  return node.getStyle().includes(FILTER_TOKEN_STYLE_MARKER);
}

export function normalizeUnifiedAgentsFilterTextNode(node: TextNode): void {
  if (mergeContinuedToken(node)) return;
  if (splitOutFilterTokens(node)) return;
  const nextStyle = filterStyleForText(node.getTextContent());
  if (node.getStyle() !== nextStyle) node.setStyle(nextStyle);
  if (!nextStyle && isSelectionInsideTextNode(node)) clearCurrentSelectionStyle();
}

/**
 * The selection keeps the style it had before a node turned into a chip, and
 * Lexical gives the next typed character a fresh node whenever the two
 * disagree: typing `/last:all` left a `/last:a` chip followed by a plain
 * `ll`. With no whitespace between them the two are one token, so fold them
 * back together; the transform re-runs on the merged node and restyles it.
 */
function mergeContinuedToken(node: TextNode): boolean {
  const previous = node.getPreviousSibling();
  if ($isTextNode(previous) && continuesToken(previous, node)) {
    previous.mergeWithSibling(node);
    return true;
  }
  const next = node.getNextSibling();
  if ($isTextNode(next) && continuesToken(node, next)) {
    node.mergeWithSibling(next);
    return true;
  }
  return false;
}

/**
 * Only a node that is exactly one token can be a chip, but typing after a
 * chip lands in the plain space node that follows it: `/last:20 /sort:x`
 * left `/sort:x` inside ` /sort:x`, never styled. Cut every filter token out
 * into its own node, styled at once: Lexical merges same-style neighbours
 * back together before the transform could reach the pieces.
 */
function splitOutFilterTokens(node: TextNode): boolean {
  const text = node.getTextContent();
  const cuts = new Set<number>();
  for (const token of tokenizeFilterText(text)) {
    if (!getUnifiedAgentsFilterTokenKey(token.text)) continue;
    cuts.add(token.start);
    cuts.add(token.end);
  }
  cuts.delete(0);
  cuts.delete(text.length);
  if (cuts.size === 0) return false;
  for (const piece of node.splitText(...[...cuts].sort((a, b) => a - b))) {
    piece.setStyle(filterStyleForText(piece.getTextContent()));
  }
  return true;
}

function continuesToken(left: TextNode, right: TextNode): boolean {
  const leftText = left.getTextContent();
  const rightText = right.getTextContent();
  if (leftText.length === 0 || rightText.length === 0) return false;
  if (/\s$/.test(leftText) || /^\s/.test(rightText)) return false;
  return leftText.startsWith("/");
}

export function insertPlainSpaceAfterFilterToken(): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;
  const anchorNode = selection.anchor.getNode();
  if (!$isTextNode(anchorNode) || !isUnifiedAgentsFilterTokenTextNode(anchorNode)) return false;
  if (selection.anchor.offset !== anchorNode.getTextContentSize()) return false;
  const spaceNode = $createTextNode(" ");
  anchorNode.insertAfter(spaceNode);
  spaceNode.select(1, 1);
  const nextSelection = $getSelection();
  if ($isRangeSelection(nextSelection)) clearSelectionStyle(nextSelection);
  return true;
}

export function getUnifiedAgentsFilterActiveToken(): UnifiedAgentsFilterActiveToken | null {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  const anchorNode = selection.anchor.getNode();
  const text = getUnifiedAgentsFilterEditorText();
  const offset = getSelectionTextOffset(anchorNode, selection.anchor.offset);
  if (offset === null) return null;
  const token = findFilterTokenAtOffset(text, offset);
  if (!token?.text.startsWith("/")) return null;
  return { text: text.slice(token.start, offset), start: token.start, end: token.end };
}

export function replaceUnifiedAgentsFilterActiveToken(
  editor: LexicalEditor,
  replacement: string,
): string | null {
  let nextText: string | null = null;
  editor.update(() => {
    const activeToken = getUnifiedAgentsFilterActiveToken();
    if (!activeToken) return;
    const currentText = getUnifiedAgentsFilterEditorText();
    const next = replaceFilterToken(currentText, { ...activeToken, pair: null }, replacement);
    nextText = next.text;
    writeUnifiedAgentsFilterEditorText(next.text, { cursorOffset: next.cursorOffset });
  });
  return nextText;
}

function writeUnifiedAgentsFilterEditorText(
  text: string,
  options: UnifiedAgentsFilterEditorWriteOptions = {},
): void {
  const root = $getRoot();
  root.clear();
  for (const line of text.split("\n")) {
    const paragraph = $createParagraphNode();
    for (const segment of splitFilterEditorSegments(line)) {
      paragraph.append(createFilterEditorNode(segment));
    }
    root.append(paragraph);
  }
  if (options.selection === "none") {
    $setSelection(null);
    return;
  }
  if (options.cursorOffset === undefined) root.getLastChild()?.selectEnd();
  else selectFilterEditorOffset(options.cursorOffset);
}

function createFilterEditorNode(text: string): LexicalNode {
  return $createTextNode(text).setStyle(filterStyleForText(text));
}

/** A chip's style when `text` is exactly one filter token, else none. */
function filterStyleForText(text: string): string {
  const filterKey = getUnifiedAgentsFilterTokenKey(text);
  return filterKey ? filterTokenStyle(filterKey) : "";
}

function isSelectionInsideTextNode(node: TextNode): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  return selection.anchor.getNode().is(node) || selection.focus.getNode().is(node);
}

function clearCurrentSelectionStyle(): void {
  const selection = $getSelection();
  if ($isRangeSelection(selection)) clearSelectionStyle(selection);
}

function clearSelectionStyle(selection: RangeSelection): void {
  selection.setFormat(0);
  selection.setStyle("");
}

function splitFilterEditorSegments(text: string): string[] {
  const segments: string[] = [];
  let cursor = 0;
  for (const token of tokenizeFilterText(text)) {
    if (token.start > cursor) segments.push(text.slice(cursor, token.start));
    segments.push(token.text);
    cursor = token.end;
  }
  if (cursor < text.length) segments.push(text.slice(cursor));
  return segments;
}

function getSelectionTextOffset(anchorNode: LexicalNode, anchorOffset: number): number | null {
  let offset = 0;
  for (const [lineIndex, paragraph] of $getRoot().getChildren().entries()) {
    if (!$isElementNode(paragraph)) continue;
    if (lineIndex > 0) offset += 1;
    for (const child of paragraph.getChildren()) {
      if (child.is(anchorNode)) return offset + anchorOffset;
      offset += child.getTextContentSize();
    }
  }
  return null;
}

function selectFilterEditorOffset(cursorOffset: number): void {
  let remaining = Math.max(0, cursorOffset);
  for (const paragraph of $getRoot().getChildren()) {
    if (!$isElementNode(paragraph)) continue;
    for (const child of paragraph.getChildren()) {
      const size = child.getTextContentSize();
      if ($isTextNode(child) && remaining <= size) {
        child.select(remaining, remaining);
        return;
      }
      remaining -= size;
    }
    remaining -= 1;
  }
  $getRoot().getLastChild()?.selectEnd();
}

function filterTokenStyle(filterKey: UnifiedAgentsFilterKey): string {
  const palette = filterTokenPalette(filterKey);
  return [
    FILTER_TOKEN_STYLE_MARKER,
    "display:inline-block",
    "border-radius:0.25rem",
    "border:1px solid",
    `border-color:${palette.border}`,
    `background:${palette.background}`,
    `color:${palette.foreground}`,
    "padding:0 0.25rem",
    "font-family:var(--font-mono)",
    "font-size:12px",
    "font-weight:600",
  ].join(";");
}

/** Chip colors come from the theme's accent tokens, so every theme (light
 *  ones included) keeps them legible. */
function filterTokenPalette(filterKey: UnifiedAgentsFilterKey): {
  border: string;
  background: string;
  foreground: string;
} {
  const accent = FILTER_TOKEN_ACCENT[filterKey];
  return {
    border: `color-mix(in oklab, ${accent} 40%, transparent)`,
    background: `color-mix(in oklab, ${accent} 12%, transparent)`,
    foreground: accent,
  };
}

const FILTER_TOKEN_ACCENT: Record<UnifiedAgentsFilterKey, string> = {
  last: "var(--acc-cyan)",
  project: "var(--acc-green)",
  pin: "var(--acc-yellow)",
  sort: "var(--acc-purple)",
  exclude: "var(--acc-purple)",
};

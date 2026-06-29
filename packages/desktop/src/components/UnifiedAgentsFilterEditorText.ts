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
  const filterKey = getUnifiedAgentsFilterTokenKey(node.getTextContent());
  const nextStyle = filterKey ? filterTokenStyle(filterKey) : "";
  if (node.getStyle() !== nextStyle) node.setStyle(nextStyle);
  if (!filterKey && isSelectionInsideTextNode(node)) clearCurrentSelectionStyle();
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
  const node = $createTextNode(text);
  const filterKey = getUnifiedAgentsFilterTokenKey(text);
  if (!filterKey) return node;
  node.setStyle(filterTokenStyle(filterKey));
  return node;
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
    "font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace",
    "font-size:12px",
    "font-weight:600",
  ].join(";");
}

function filterTokenPalette(filterKey: UnifiedAgentsFilterKey): {
  border: string;
  background: string;
  foreground: string;
} {
  if (filterKey === "last") {
    return { border: "#38bdf855", background: "#0ea5e91f", foreground: "#38bdf8" };
  }
  if (filterKey === "project") {
    return { border: "#34d39955", background: "#10b9811f", foreground: "#34d399" };
  }
  if (filterKey === "pin") {
    return { border: "#fbbf2455", background: "#f59e0b1f", foreground: "#fbbf24" };
  }
  return { border: "#a78bfa55", background: "#8b5cf61f", foreground: "#a78bfa" };
}

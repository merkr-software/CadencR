import {
  TextNode,
  type DOMConversionMap,
  type DOMExportOutput,
  type EditorConfig,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";

type SerializedMentionNode = Spread<{ mentionPath: string }, SerializedTextNode>;

export class MentionNode extends TextNode {
  __mentionPath: string;

  static getType(): string {
    return "mention";
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__mentionPath, node.__text, node.__key);
  }

  constructor(mentionPath: string, text?: string, key?: NodeKey) {
    super(text ?? `@${mentionPath}`, key);
    this.__mentionPath = mentionPath;
  }

  getMentionPath(): string {
    return this.__mentionPath;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const el = super.createDOM(config);
    // Cyan is the design system's file-reference hue (DESIGN.md › Iconography),
    // matching how the transcript renders the same path.
    el.className =
      "inline-block rounded border border-[var(--acc-cyan)]/30 bg-[var(--acc-cyan)]/10 px-1 text-sm font-medium text-[var(--acc-cyan)]";
    el.spellcheck = false;
    el.dataset.mentionPath = this.__mentionPath;
    return el;
  }

  updateDOM(): boolean {
    // Always recreate — styling is static
    return false;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement("span");
    element.textContent = this.getTextContent();
    element.dataset.mentionPath = this.__mentionPath;
    return { element };
  }

  static importDOM(): DOMConversionMap | null {
    return null;
  }

  static importJSON(serializedNode: SerializedMentionNode): MentionNode {
    return $createMentionNode(serializedNode.mentionPath, serializedNode.text);
  }

  exportJSON(): SerializedMentionNode {
    return {
      ...super.exportJSON(),
      type: "mention",
      mentionPath: this.__mentionPath,
    };
  }

  getTextContent(): string {
    return `@${this.__mentionPath}`;
  }

  canInsertTextBefore(): boolean {
    return false;
  }

  canInsertTextAfter(): boolean {
    return false;
  }

  isTextEntity(): boolean {
    return true;
  }
}

export function $createMentionNode(mentionPath: string, text?: string): MentionNode {
  const node = new MentionNode(mentionPath, text);
  node.setMode("token");
  return node;
}

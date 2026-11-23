import {
  TextNode,
  type LexicalNode,
  type DOMConversionMap,
  type DOMExportOutput,
  type EditorConfig,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";
import { serializeConversationReference } from "../conversation-reference";

const CHIP_CLASS =
  "inline-block rounded border border-[var(--chip-fuchsia-fg)]/25 bg-[var(--chip-fuchsia-bg)]/18 px-1 text-sm font-semibold text-[var(--chip-fuchsia-fg)]";

/**
 * The project badge, drawn before the label once `applyConversationProjectBadge`
 * knows the project: the logo at `ProjectBadge` xs size, or the color dot one
 * step larger than xs so it reads in the 14px semibold chip. A text node cannot
 * host a React `ProjectBadge`, and a pseudo-element stays out of the node's
 * text, so selection offsets and the serialized prompt are untouched.
 */
const PROJECT_BADGE_CLASS = [
  "before:hidden before:align-[-0.125em] before:content-[''] before:mr-1",
  "data-[project-badge]:before:inline-block",
  "data-[project-badge=dot]:before:size-2 data-[project-badge=dot]:before:rounded-full data-[project-badge=dot]:before:bg-(--conversation-project-color) data-[project-badge=dot]:before:align-[0.05em]",
  "data-[project-badge=icon]:before:size-3.5 data-[project-badge=icon]:before:rounded-sm data-[project-badge=icon]:before:bg-(image:--conversation-project-icon) data-[project-badge=icon]:before:bg-contain data-[project-badge=icon]:before:bg-center data-[project-badge=icon]:before:bg-no-repeat",
].join(" ");

export interface ConversationProjectBadge {
  /** Hex color without `#`, as project settings store it. */
  color: string;
  /** A decodable image URL, or `null` to draw the color dot. */
  iconUrl: string | null;
}

/** Show `badge` on a chip element, or clear it with `null`. */
export function applyConversationProjectBadge(
  element: HTMLElement,
  badge: ConversationProjectBadge | null,
): void {
  if (!badge) {
    delete element.dataset.projectBadge;
    element.style.removeProperty("--conversation-project-color");
    element.style.removeProperty("--conversation-project-icon");
    return;
  }
  element.dataset.projectBadge = badge.iconUrl ? "icon" : "dot";
  element.style.setProperty("--conversation-project-color", `#${badge.color}`);
  if (badge.iconUrl)
    element.style.setProperty("--conversation-project-icon", `url("${badge.iconUrl}")`);
  else element.style.removeProperty("--conversation-project-icon");
}

type SerializedConversationReferenceNode = Spread<
  { featureId: number; label: string },
  SerializedTextNode
>;

export class ConversationReferenceNode extends TextNode {
  __featureId: number;
  __label: string;

  static getType(): string {
    return "conversation-reference";
  }

  static clone(node: ConversationReferenceNode): ConversationReferenceNode {
    return new ConversationReferenceNode(node.__featureId, node.__label, node.__key);
  }

  constructor(featureId: number, label: string, key?: NodeKey) {
    super(`@@${label}`, key);
    this.__featureId = featureId;
    this.__label = label;
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = super.createDOM(config);
    element.textContent = `@@${this.__label}`;
    element.className = `${CHIP_CLASS} ${PROJECT_BADGE_CLASS}`;
    element.dataset.conversationFeatureId = String(this.__featureId);
    return element;
  }

  getFeatureId(): number {
    return this.getLatest().__featureId;
  }

  updateDOM(): boolean {
    return false;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement("span");
    element.textContent = this.getTextContent();
    element.dataset.conversationFeatureId = String(this.__featureId);
    return { element };
  }

  static importDOM(): DOMConversionMap | null {
    return null;
  }

  static importJSON(
    serializedNode: SerializedConversationReferenceNode,
  ): ConversationReferenceNode {
    return $createConversationReferenceNode(serializedNode.featureId, serializedNode.label);
  }

  exportJSON(): SerializedConversationReferenceNode {
    return {
      ...super.exportJSON(),
      type: "conversation-reference",
      featureId: this.__featureId,
      label: this.__label,
    };
  }

  getTextContent(): string {
    return serializeConversationReference({ featureId: this.__featureId, label: this.__label });
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

export function $createConversationReferenceNode(
  featureId: number,
  label: string,
): ConversationReferenceNode {
  const node = new ConversationReferenceNode(featureId, label);
  node.setMode("token");
  return node;
}

export function $isConversationReferenceNode(
  node: LexicalNode | null | undefined,
): node is ConversationReferenceNode {
  return node instanceof ConversationReferenceNode;
}

import type { AgentBlockData } from "@/types/agent-block";
import type { DisplayItem } from "@/types/agent-stream";
import { isDeliveredPrompt } from "@/lib/agent-stream-summary";

/**
 * What a finished turn says about itself once, under its last row: the
 * model(s) that wrote its prose and when it ended. The live turn summary
 * ("Worked - 21s · …") carries it on the same line.
 */
export interface TurnFooter {
  /** Models of the turn's root prose in the order they wrote (repeats collapsed). */
  models: readonly string[];
  /** ISO time of the turn's last block that carries one. */
  endedAt?: string;
}

/** Where the model writing the conversation's prose changed. */
export interface ModelSwitch {
  from: string;
  to: string;
}

/** What a display row carries besides its own blocks. */
export interface RowAnnotation {
  /** Drawn above the row. */
  modelSwitch?: ModelSwitch;
  /** Drawn under the row, or on it when it is the live turn summary. */
  footer?: TurnFooter;
}

/**
 * Rows only a finished turn ends on. Not `error`: some arrive while the turn
 * runs on (a dropped connection reconnecting, a refused manual compact).
 */
const TURN_END_TYPES = new Set<AgentBlockData["type"]>(["turn_summary", "turn_interrupted"]);

function itemBlocks(item: DisplayItem): readonly AgentBlockData[] {
  return item.kind === "flow" ? item.blocks : [item.block];
}

/** Summary mode folds a turn's intermediate prose into its recap's children. */
function forEachProseModel(block: AgentBlockData, visit: (model: string) => void): void {
  if (block.type === "text" && block.model) visit(block.model);
  if (block.type !== "tool_summary" || !block.childBlocks) return;
  for (const child of block.childBlocks) forEachProseModel(child, visit);
}

interface OpenTurn {
  models: string[];
  endedAt?: string;
  firstKey: string | null;
  lastKey: string | null;
  /** Its last row is one only a finished turn ends on. */
  ended: boolean;
}

const openTurn = (): OpenTurn => ({ models: [], firstKey: null, lastKey: null, ended: false });

/**
 * Annotations keyed by display item. Attached to existing rows rather than
 * added as rows of their own, so the Virtuoso row count
 * `countRenderableDisplayRows` mirrors for prepend anchoring stays unchanged.
 *
 * - **Footer** on each finished turn's last agent row (the live turn summary
 *   when there is one). A delivered user message — a prompt, or a steer the
 *   agent received — closes the exchange before it, as Summary mode's recaps
 *   do. The exchange still in flight gets none, unless its last row already
 *   says it ended (a message from another agent waiting for its receipt keeps
 *   the session busy without reopening the finished turn). A turn without
 *   attributed prose gets none either.
 * - **Model switch** where the prose's model changed. Every reply carries the
 *   model that wrote it, so this lands wherever the provider applied the
 *   change, without knowing the provider: Codex applies a switch at the next
 *   turn, Claude (`set_model`, `opusplan`) and ACP agents can apply it inside
 *   one. A turn whose first prose already runs on the new model switched at
 *   its start (its first agent row); otherwise the switch sits on the row of
 *   the first reply that used it — the reply before it still ran on the old one.
 */
export function buildRowAnnotations(
  items: readonly DisplayItem[],
  turnActive: boolean,
): Map<string, RowAnnotation> {
  const annotations = new Map<string, RowAnnotation>();
  const annotate = (key: string, patch: RowAnnotation): void => {
    annotations.set(key, { ...annotations.get(key), ...patch });
  };
  const markSwitch = (key: string, from: string, to: string): void => {
    // Summary mode can fold a switch and its way back into one recap row.
    const first = annotations.get(key)?.modelSwitch?.from ?? from;
    if (first !== to) return annotate(key, { modelSwitch: { from: first, to } });
    const footer = annotations.get(key)?.footer;
    if (footer) annotations.set(key, { footer });
    else annotations.delete(key);
  };
  let lastModel: string | null = null;
  let turn = openTurn();
  const close = (): void => {
    if (turn.lastKey && turn.models.length > 0) {
      annotate(turn.lastKey, { footer: { models: turn.models, endedAt: turn.endedAt } });
    }
    turn = openTurn();
  };
  for (const item of items) {
    if (item.kind === "block" && item.block.type === "user_message") {
      if (isDeliveredPrompt(item.block) || turn.ended) close();
      continue;
    }
    turn.firstKey ??= item.key;
    for (const block of itemBlocks(item)) {
      forEachProseModel(block, (model) => {
        if (lastModel !== null && model !== lastModel) {
          const at = turn.models.length === 0 ? (turn.firstKey ?? item.key) : item.key;
          markSwitch(at, lastModel, model);
        }
        lastModel = model;
        if (turn.models.at(-1) !== model) turn.models.push(model);
      });
      if (block.createdAt) turn.endedAt = block.createdAt;
    }
    turn.lastKey = item.key;
    turn.ended = item.kind === "block" && TURN_END_TYPES.has(item.block.type);
  }
  if (!turnActive || turn.ended) close();
  return annotations;
}

function sameModels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((model, index) => model === b[index]);
}

function sameAnnotation(a: RowAnnotation, b: RowAnnotation): boolean {
  const sameSwitch =
    a.modelSwitch === b.modelSwitch ||
    (a.modelSwitch?.from === b.modelSwitch?.from && a.modelSwitch?.to === b.modelSwitch?.to);
  const sameFooter =
    a.footer === b.footer ||
    (!!a.footer &&
      !!b.footer &&
      a.footer.endedAt === b.footer.endedAt &&
      sameModels(a.footer.models, b.footer.models));
  return sameSwitch && sameFooter;
}

/**
 * Reuse `previous` (and each of its annotations) when nothing changed, so a
 * streaming chunk that leaves every annotation as it was busts no row memo.
 */
export function reuseRowAnnotations(
  previous: Map<string, RowAnnotation> | null,
  next: Map<string, RowAnnotation>,
): Map<string, RowAnnotation> {
  if (!previous) return next;
  let changed = previous.size !== next.size;
  const merged = new Map<string, RowAnnotation>();
  for (const [key, annotation] of next) {
    const old = previous.get(key);
    if (old && sameAnnotation(old, annotation)) merged.set(key, old);
    else {
      merged.set(key, annotation);
      changed = true;
    }
  }
  return changed ? merged : previous;
}

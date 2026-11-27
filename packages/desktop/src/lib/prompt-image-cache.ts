import { translateUi } from "@/shared/ui-i18n";
/**
 * Off-heap store for the attachment payloads carried by `user_message` blocks.
 *
 * A prompt with an image persists its content as a JSON envelope whose `data`
 * leaves are base64 — a 3 MB screenshot lands as a 4.4 MB string, and in
 * production single user messages reach 3.3 MB. That is a problem twice over:
 *
 * 1. **Correctness.** `applyBlockContentBudget` clamps any block over
 *    `BLOCK_CONTENT_MAX_CHARS`, and a raw clamp splices a notice into the middle
 *    of the envelope. The result no longer parses, `parseUserMessageContent`
 *    falls back to "render the content as text", and the user sees a wall of
 *    base64 instead of their screenshot.
 * 2. **Memory.** The envelope is retained in the Zustand store for the whole
 *    session, as a UTF-16 string — two bytes per base64 character.
 *
 * So payloads are lifted out of the block content before the budget runs: each
 * one is decoded into a `Blob` (native memory, ~3× smaller than the base64
 * string it replaces) and the envelope keeps a short `cadencr_ref` in its place.
 * What stays in the store is a few hundred bytes of JSON that always parses.
 *
 * Refs are content fingerprints, not block ids, so the live `ws-user-*` block
 * and the `msg-<dbId>` block it reconciles into resolve to the same single
 * entry instead of stashing the image twice.
 */

import {
  PROMPT_BLOB_REF_TYPE,
  type ParsedUserMessageImage,
  type RawUserMessageBlock,
} from "@/types/agent-types";

/**
 * Ceiling for everything held here. Blobs are native allocations rather than JS
 * heap, but they are still process memory, so a long session that pastes
 * hundreds of screenshots has to shed the oldest ones. Eviction is by insertion
 * order and revokes the URL, so a still-mounted `<img>` for an evicted payload
 * fails to load — every consumer renders a placeholder on `error` rather than a
 * broken-image glyph.
 */
const MAX_CACHE_BYTES = 192 * 1024 * 1024;

interface PromptBlobEntry {
  blob: Blob;
  url: string;
}

const cache = new Map<string, PromptBlobEntry>();
let cachedBytes = 0;

/** Blob URLs need a real `URL.createObjectURL`; jsdom and SSR have none. */
function canCreateObjectUrls(): boolean {
  return typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
}

function base64ToBlob(base64: string, mediaType: string): Blob | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mediaType });
  } catch {
    // Malformed base64 — leave the payload inline so the caller keeps whatever
    // fidelity it still has rather than dropping the attachment entirely.
    return null;
  }
}

/**
 * Identify a payload by its own bytes so the same image stashed from two block
 * shapes collapses to one entry.
 *
 * Samples the middle as well as the ends: every PNG shares the first ~24 base64
 * characters (signature + IHDR header) and every JPEG the first ~16, so ends
 * alone would degrade the fingerprint to `mediaType + length` and two
 * same-sized screenshots would resolve to each other's pixels.
 */
function fingerprint(mediaType: string, base64: string): string {
  const middle = base64.length >> 1;
  return [
    mediaType,
    base64.length,
    base64.slice(0, 24),
    base64.slice(middle, middle + 24),
    base64.slice(-24),
  ].join(":");
}

function evictToFit(): void {
  for (const [ref, entry] of cache) {
    if (cachedBytes <= MAX_CACHE_BYTES) return;
    cache.delete(ref);
    cachedBytes -= entry.blob.size;
    URL.revokeObjectURL(entry.url);
  }
}

/**
 * Move a base64 payload into the cache. Returns the ref, or `null` when the
 * payload could not be off-loaded — callers must then keep it inline.
 */
export function stashPromptBlob(mediaType: string, base64: string): string | null {
  if (!canCreateObjectUrls()) return null;
  const ref = fingerprint(mediaType, base64);
  if (cache.has(ref)) return ref;
  const blob = base64ToBlob(base64, mediaType);
  if (!blob) return null;
  cache.set(ref, { blob, url: URL.createObjectURL(blob) });
  cachedBytes += blob.size;
  evictToFit();
  return ref;
}

/**
 * Build an image source for a parsed attachment: the cached blob URL when the
 * payload was off-loaded, an inline data URL when it never was, and `null` when
 * the ref has been evicted (the caller renders a placeholder).
 *
 * Deliberately a pure read — it runs inside render, so it must not reorder the
 * cache or otherwise mutate module state.
 */
export function promptImageSrc(image: ParsedUserMessageImage): string | null {
  if (image.ref) return cache.get(image.ref)?.url ?? null;
  if (image.base64) return `data:${image.mediaType};base64,${image.base64}`;
  return null;
}

/** Re-encode a blob as base64 without its `data:` URL prefix. */
export async function readBlobBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result as string));
    reader.addEventListener("error", () =>
      reject(
        reader.error ?? new Error(translateUi("conversation.images.readFailed", "read failed")),
      ),
    );
    reader.readAsDataURL(blob);
  });
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/** Re-encode a cached payload as base64 — used when a prompt is re-sent. */
export async function readPromptBlobBase64(ref: string): Promise<string | undefined> {
  const entry = cache.get(ref);
  return entry ? readBlobBase64(entry.blob) : undefined;
}

function stashImageBlock(block: RawUserMessageBlock): RawUserMessageBlock | null {
  const source = block.source;
  if (source?.type !== "base64" || !source.media_type || !source.data) return null;
  const ref = stashPromptBlob(source.media_type, source.data);
  if (!ref) return null;
  return {
    ...block,
    source: { type: PROMPT_BLOB_REF_TYPE, media_type: source.media_type, ref },
  };
}

function stashAttachmentBlock(block: RawUserMessageBlock): RawUserMessageBlock | null {
  if (!block.data || !block.media_type) return null;
  const ref = stashPromptBlob(block.media_type, block.data);
  if (!ref) return null;
  const { data: _data, ...rest } = block;
  return { ...rest, ref };
}

/**
 * Lift every base64 payload out of a `user_message` envelope. Returns the input
 * string unchanged when there is nothing to move, so the store's identity
 * checks (and `React.memo` downstream) are unaffected for ordinary messages.
 */
export function extractPromptBlobs(content: string): string {
  // Cheap rejects first: only a JSON envelope carrying a `data` leaf can hold a
  // payload, and a re-processed block already has refs instead. `"data":"` and
  // not `"data"` — the latter also matches an escaped `\"data\"` in the user's
  // own prose, which would buy a full parse on every pass forever.
  if (!content.startsWith("[") || !content.includes('"data":"')) return content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  if (!Array.isArray(parsed)) return content;

  let changed = false;
  const next = (parsed as RawUserMessageBlock[]).map((block) => {
    const stashed =
      block?.type === "image"
        ? stashImageBlock(block)
        : block?.type === "attachment"
          ? stashAttachmentBlock(block)
          : null;
    if (!stashed) return block;
    changed = true;
    return stashed;
  });
  return changed ? JSON.stringify(next) : content;
}

/** Drop every entry. Test-only — production keeps the cache for the session. */
export function resetPromptBlobCacheForTest(): void {
  for (const entry of cache.values()) URL.revokeObjectURL(entry.url);
  cache.clear();
  cachedBytes = 0;
}

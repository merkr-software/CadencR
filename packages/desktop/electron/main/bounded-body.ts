/** True when a `Content-Length` header already announces more than `maxBytes`. */
export function declaredTooLarge(rawLength: string | null, maxBytes: number): boolean {
  if (!rawLength) return false;
  const length = Number(rawLength);
  return Number.isFinite(length) && length > maxBytes;
}

/**
 * Read a response body, cancelling as soon as it exceeds `maxBytes` — a
 * missing or lying `Content-Length` can't make us buffer more than the cap.
 * Returns `null` when there is no body or it is over the limit.
 */
export async function readBounded(
  body: ReadableStream<Uint8Array<ArrayBuffer>> | null,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

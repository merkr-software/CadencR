import { StringDecoder } from "node:string_decoder";

export function serializeJsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

export class JsonlFrameLimitError extends Error {}

export const MAX_JSONL_FRAME_BYTES = 16 * 1024 * 1024;

export function attachJsonlReader(stream, onMessage, onError, maxBytes = MAX_JSONL_FRAME_BYTES) {
  const decoder = new StringDecoder("utf8");
  let fragments = [];
  let frameBytes = 0;
  let failed = false;
  const append = (fragment) => {
    frameBytes += Buffer.byteLength(fragment);
    if (frameBytes > maxBytes) {
      failed = true;
      fragments = [];
      onError(new JsonlFrameLimitError(`JSONL frame exceeds ${maxBytes} bytes`));
      return false;
    }
    if (fragment) fragments.push(fragment);
    return true;
  };
  const emitFrame = () => {
    const line = fragments.join("").replace(/\r$/, "");
    fragments = [];
    frameBytes = 0;
    parseLine(line, onMessage, onError);
  };
  const consume = (text, final = false) => {
    if (failed) return;
    let start = 0;
    let newline;
    while ((newline = text.indexOf("\n", start)) !== -1) {
      if (!append(text.slice(start, newline))) return;
      emitFrame();
      start = newline + 1;
    }
    if (!append(text.slice(start))) return;
    if (final && fragments.length) emitFrame();
  };

  const onData = (chunk) => {
    consume(typeof chunk === "string" ? chunk : decoder.write(chunk));
  };
  const onEnd = () => consume(decoder.end(), true);
  stream.on("data", onData);
  stream.on("end", onEnd);

  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

function parseLine(line, onMessage, onError) {
  if (line.length === 0) return;
  try {
    onMessage(JSON.parse(line));
  } catch (error) {
    onError(new Error(`invalid JSONL frame: ${error.message}`));
  }
}

export class JsonLineWriter {
  #stream;
  #tail = Promise.resolve();

  #onError;
  #closed = false;

  constructor(stream, onError = () => {}) {
    this.#stream = stream;
    this.#onError = onError;
    stream.on("error", this.#onError);
  }

  async close() {
    this.#closed = true;
    await this.#tail.catch(() => undefined);
    // Writable errors can be emitted after their write callback rejects.
    await new Promise((resolve) => setImmediate(resolve));
    this.#stream.off("error", this.#onError);
  }

  write(value) {
    if (this.#closed) return Promise.reject(new Error("ACP output closed"));
    const frame = serializeJsonLine(value);
    this.#tail = this.#tail.then(
      () =>
        new Promise((resolve, reject) => {
          this.#stream.write(frame, (error) => {
            if (error) reject(error);
            else resolve();
          });
        }),
    );
    return this.#tail;
  }
}

// First-party bounded framing. Upstream server code remains unchanged.
const MAX_FRAME = 8 * 1024 * 1024;
const MAX_PENDING = 16 * 1024 * 1024;
const writers = new WeakMap();

function writeBytes(stream, buffer) {
  if (stream.destroyed || stream.writableEnded) throw new Error("LSP output is closed");
  let state = writers.get(stream);
  if (!state) {
    state = { queue: [], bytes: 0, pending: null };
    writers.set(stream, state);
  }
  if (state.bytes + stream.writableLength + buffer.length > MAX_PENDING) {
    throw new Error("LSP output backlog exceeds bound");
  }
  if (state.pending) {
    state.queue.push(buffer);
    state.bytes += buffer.length;
    return state.pending;
  }
  if (stream.write(buffer)) return;
  state.pending = new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("drain", drain);
      stream.off("error", error);
      stream.off("close", close);
      state.pending = null;
      state.queue = [];
      state.bytes = 0;
    };
    const error = (error) => { cleanup(); reject(error); };
    const close = () => error(new Error("LSP output closed before drain"));
    const drain = () => {
      try {
        while (state.queue.length) {
          const next = state.queue.shift();
          state.bytes -= next.length;
          if (!stream.write(next)) return;
        }
        cleanup();
        resolve();
      } catch (failure) { error(failure); }
    };
    stream.on("drain", drain);
    stream.on("error", error);
    stream.on("close", close);
  });
  return state.pending;
}

export function write(stream, message) {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > MAX_FRAME) throw new Error("LSP frame exceeds bound");
  return writeBytes(stream, Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}

export function frames(stream, receive, fail) {
  let pending = Buffer.alloc(0);
  let waiting = false;
  let ended = false;
  let failed = false;
  const failure = (error) => {
    if (failed) return;
    failed = true;
    stream.pause();
    pending = Buffer.alloc(0);
    fail(error);
  };
  function consume() {
    try {
      while (!waiting && !failed) {
        // TypeScript emits an extra newline between framed responses.
        while (pending[0] === 10 || pending[0] === 13) pending = pending.subarray(1);
        const boundary = pending.indexOf("\r\n\r\n");
        if (boundary > 16384) throw new Error("LSP header exceeds bound");
        if (boundary < 0) {
          if (pending.length > 16384) throw new Error("LSP header exceeds bound");
          break;
        }
        const header = pending.subarray(0, boundary).toString("ascii");
        const lengths = [...header.matchAll(/^Content-Length: (\d+)$/gim)];
        if (lengths.length !== 1) throw new Error("One Content-Length required");
        const size = Number(lengths[0][1]);
        if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FRAME) throw new Error("Invalid frame size");
        if (pending.length < boundary + 4 + size) break;
        const body = pending.subarray(boundary + 4, boundary + 4 + size);
        pending = pending.subarray(boundary + 4 + size);
        const completion = receive(JSON.parse(body.toString("utf8")));
        if (completion && typeof completion.then === "function") {
          waiting = true;
          stream.pause();
          completion.then(() => {
            waiting = false;
            consume();
            if (!waiting && !failed) stream.resume();
          }, failure);
        }
      }
      if (ended && !waiting && pending.length) throw new Error("LSP stream ended with a partial frame");
    } catch (error) { failure(error); }
  }
  stream.on("data", (chunk) => {
    if (failed) return;
    if (pending.length + chunk.length > MAX_FRAME + 16384) {
      failure(new Error("Pending frame exceeds bound"));
      return;
    }
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    consume();
  });
  stream.on("error", failure);
  stream.on("end", () => { ended = true; consume(); });
}

export class TypeScriptConnection {
  constructor(process, event, fail) {
    this.process = process;
    this.pending = new Map();
    this.sequence = 0;
    this.fail = fail;
    this.output = undefined;
    frames(process.stdout, (message) => {
      if (message.type === "event") return event(message);
      if (message.type !== "response") return;
      const waiter = this.pending.get(message.request_seq);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(message.request_seq);
      if (message.success) waiter.resolve(message.body);
      else waiter.reject(new Error(`TypeScript ${message.command} failed: ${message.message}`));
    }, fail);
  }

  notify(command, args) {
    const seq = ++this.sequence;
    const body = Buffer.from(`${JSON.stringify({ seq, type: "request", command, arguments: args })}\n`);
    if (body.length > MAX_FRAME) throw new Error("TypeScript frame exceeds bound");
    const output = writeBytes(this.process.stdin, body);
    if (output !== this.output) output?.catch(this.fail);
    this.output = output;
    return seq;
  }

  flush() {
    return this.output;
  }

  request(command, args) {
    if (this.pending.size >= 256) return Promise.reject(new Error("Too many TypeScript requests"));
    return new Promise((resolve, reject) => {
      const seq = this.notify(command, args);
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`TypeScript ${command} timed out`));
      }, 20000);
      this.pending.set(seq, { resolve, reject, timer });
    });
  }

  dispose() {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("TypeScript bridge closed"));
    }
    this.pending.clear();
  }
}

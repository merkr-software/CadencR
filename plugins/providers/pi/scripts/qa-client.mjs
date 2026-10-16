import { attachJsonlReader, serializeJsonLine } from "../src/jsonl.mjs";

const failedSpawns = new WeakSet();

export function qaClient(
  child,
  { permissionPolicy = () => "reject_once", timeoutMs = 120_000 } = {},
) {
  let stderr = "";
  let requestId = 0;
  const pending = new Map();
  const updates = [];
  const permissions = [];
  let failure;
  const fail = (error) => {
    failure ??= error;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(failure);
    }
    pending.clear();
  };
  const onExit = (code, signal) => fail(new Error(`live QA child exited: ${signal ?? code}`));
  const onError = (error) => {
    if (child.pid === undefined) failedSpawns.add(child);
    fail(error);
  };
  child.on("error", onError);
  child.on("exit", onExit);
  child.stdin.on("error", fail);
  const write = (message) => {
    if (failure) throw failure;
    child.stdin.write(serializeJsonLine(message), (error) => {
      if (error) fail(error);
    });
  };

  const onStderr = (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-65_536);
  };
  child.stderr.on("data", onStderr);
  const detach = attachJsonlReader(
    child.stdout,
    (message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        fail(new Error("invalid ACP QA response"));
        return;
      }
      if (message.method === "session/request_permission" && message.id !== undefined) {
        const tool = message.params?.toolCall;
        const optionId = permissionPolicy(tool);
        write({
          jsonrpc: "2.0",
          id: message.id,
          result: { outcome: { outcome: "selected", optionId } },
        });
        permissions.push({ toolCallId: tool?.toolCallId, optionId });
        return;
      }
      if (message.method === "session/update") {
        updates.push(message.params?.update);
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    },
    fail,
  );

  function request(method, params, requestTimeoutMs = timeoutMs) {
    if (failure) return Promise.reject(failure);
    const id = ++requestId;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`${method} timed out: ${stderr}`));
      }, requestTimeoutMs);
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      try {
        write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        fail(error);
      }
    });
  }

  return {
    request,
    updates,
    permissions,
    dispose() {
      detach();
      child.stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      closeInput(child.stdin, fail);
      fail(new Error("live QA client closed"));
    },
  };
}

function closeInput(input, onError) {
  if (input.closed) input.off("error", onError);
  else {
    // Keep the error handler until destroy's queued errors and close have fired.
    input.once("close", () => input.off("error", onError));
    input.destroy();
  }
}

function childExited(child) {
  return failedSpawns.has(child) || child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child, action, timeoutMs) {
  if (childExited(child)) return true;
  let timer;
  let onExit;
  try {
    return await new Promise((resolveWait, rejectWait) => {
      onExit = () => resolveWait(true);
      child.once("exit", onExit);
      timer = setTimeout(() => resolveWait(false), timeoutMs);
      try {
        action();
      } catch (error) {
        rejectWait(error);
      }
    });
  } finally {
    clearTimeout(timer);
    child.off("exit", onExit);
  }
}

export async function stopChild(child, { graceMs = 5000, signalMs = 2000 } = {}) {
  if (await waitForExit(child, () => child.stdin.end(), graceMs)) return;
  if (await waitForExit(child, () => child.kill("SIGTERM"), signalMs)) return;
  if (await waitForExit(child, () => child.kill("SIGKILL"), signalMs)) return;
  throw new Error("live QA child did not exit after SIGKILL");
}

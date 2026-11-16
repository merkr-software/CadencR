import type { MethodName, MethodParams, MethodResult } from "./protocol.js";

/** Sends one protocol request. Every namespace is built on this. */
export type Requester = <M extends MethodName>(
  method: M,
  params: MethodParams<M>,
  timeoutMs?: number,
) => Promise<MethodResult<M>>;

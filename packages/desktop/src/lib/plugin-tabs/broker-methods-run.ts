import type { BackendRequestResult, ExecRunResult } from "@cadencr/tab-sdk/protocol";
import { z } from "zod";

import { unexpectedShape } from "./broker-errors";
import { MAX_RELAY_BODY_BYTES, SELF, jsonText, readJson } from "./broker-http";
import { parseParams, type BrokerRuntime, type MethodHandler } from "./broker-runtime";

/**
 * The tab levels past the page (docs/CUSTOM_TABS.md §4.6, §4.7): `exec.run`
 * for a tab that lists `commands`, `backend.request` for one that ships a
 * `backend`. Only the request's shape is checked here; the service owns every
 * bound and enforces both against the consented manifest, so a refused
 * attempt shows in the tab's Activity instead of vanishing in the renderer.
 */

const execSchema = z.object({
  program: z.string(),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().optional(),
});

const backendSchema = z.object({
  method: z.string(),
  params: z.unknown().optional(),
  timeoutMs: z.number().int().optional(),
});

const execResultSchema = z.object({
  exit_code: z.number().int().nullable(),
  success: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  duration_ms: z.number(),
});

const backendResultSchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

async function execRun(params: unknown, runtime: BrokerRuntime) {
  const request = parseParams(execSchema, params, "exec.run");
  const response = await runtime.http.sendOk({
    method: "POST",
    path: `${SELF}/exec`,
    body: jsonText(
      { program: request.program, args: request.args ?? [], timeout_ms: request.timeoutMs },
      MAX_RELAY_BODY_BYTES,
      "exec.run",
    ),
    contentType: "application/json",
  });
  const parsed = execResultSchema.safeParse(await readJson(response));
  if (!parsed.success) throw unexpectedShape("exec.run");
  const { exit_code, success, stdout, stderr, duration_ms } = parsed.data;
  const result: ExecRunResult = {
    exitCode: exit_code,
    success,
    stdout,
    stderr,
    durationMs: duration_ms,
  };
  return { result };
}

async function backendRequest(params: unknown, runtime: BrokerRuntime) {
  const request = parseParams(backendSchema, params, "backend.request");
  const response = await runtime.http.sendOk({
    method: "POST",
    path: `${SELF}/backend`,
    body: jsonText(
      { method: request.method, params: request.params ?? null, timeout_ms: request.timeoutMs },
      MAX_RELAY_BODY_BYTES,
      "backend.request",
    ),
    contentType: "application/json",
  });
  const parsed = backendResultSchema.safeParse(await readJson(response));
  if (!parsed.success) throw unexpectedShape("backend.request");
  // The backend's own JSON goes to the guest as is.
  return { result: parsed.data as BackendRequestResult };
}

export const RUN_METHODS: Readonly<Record<string, MethodHandler>> = {
  "exec.run": execRun,
  "backend.request": backendRequest,
};

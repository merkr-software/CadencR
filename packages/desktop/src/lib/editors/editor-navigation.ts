import type { EditorOpenFileParams } from "@cadencr/tab-sdk/protocol";
import { z } from "zod";
import { pluginEditorInstanceId } from "@/lib/plugin-tabs/instance-id";
import type { EditorTarget } from "./editor-registry";
import type { PluginSurfaceRegistry } from "./surface-registry";

const paramsSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
});
const responseSchema = z
  .object({
    result: z.unknown().optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  })
  .refine((value) => Object.hasOwn(value, "result") !== Object.hasOwn(value, "error"));

export interface BuiltinEditorAdapter {
  open: (
    featureId: number,
    params: EditorOpenFileParams,
    reveal: () => void,
    isCurrent?: () => boolean,
  ) => Promise<void>;
  focus: (featureId: number, isCurrent?: () => boolean) => void | Promise<void>;
}

export interface EditorNavigationRequest {
  featureId: number;
  target: EditorTarget | (() => Promise<EditorTarget>);
  params: EditorOpenFileParams;
  reveal: () => void;
  fallback: (params: EditorOpenFileParams, reason?: string) => void;
  opened: (params: EditorOpenFileParams) => void;
  failed?: (reason: string) => void;
  timeoutMs?: number;
  isCurrent?: () => boolean;
}

/** Each conversation owns its ordering; requests with effects are never replayed. */
export class EditorNavigationController {
  private readonly latest = new Map<number, symbol>();

  constructor(
    private readonly deps: {
      surfaces: PluginSurfaceRegistry;
      builtin: BuiltinEditorAdapter;
      report: (error: Error) => void;
    },
  ) {}

  isOpening(featureId: number): boolean {
    return this.latest.has(featureId);
  }

  async focus(featureId: number, target: EditorTarget, isCurrent = () => true): Promise<void> {
    if (!isCurrent()) return;
    if (target.kind === "neovim") await this.deps.builtin.focus(featureId, isCurrent);
    else if (target.kind === "plugin") {
      const instanceId = pluginEditorInstanceId(featureId, target.plugin.id);
      try {
        const controls = await this.deps.surfaces.wait(instanceId);
        if (isCurrent() && this.deps.surfaces.isCurrent(instanceId, controls))
          await controls.focus();
      } catch (error: unknown) {
        // A tab left while its surface was loading no longer owns focus.
        if (isCurrent()) throw error;
      }
    }
  }

  async open(request: EditorNavigationRequest): Promise<void> {
    const token = Symbol();
    this.latest.set(request.featureId, token);
    const current = (): boolean =>
      this.latest.get(request.featureId) === token && (request.isCurrent?.() ?? true);
    let params: EditorOpenFileParams | undefined;
    try {
      params = paramsSchema.parse(request.params);
      const target = typeof request.target === "function" ? await request.target() : request.target;
      if (!current()) return;
      if (target.kind === "codemirror") {
        request.reveal();
        request.fallback(params, target.reason);
      } else if (target.kind === "neovim") {
        await this.deps.builtin.open(request.featureId, params, request.reveal, current);
        if (!current()) return;
        request.opened(params);
        await this.deps.builtin.focus(request.featureId, current);
      } else if (target.kind === "plugin") {
        request.reveal();
        const instanceId = pluginEditorInstanceId(request.featureId, target.plugin.id);
        const controls = await this.deps.surfaces.wait(instanceId, request.timeoutMs);
        if (!current()) return;
        const method = target.plugin.editor?.open_method;
        if (!method) throw new Error("The selected plugin does not contribute an editor.");
        const response = responseSchema.parse(await controls.requestBackend(method, params));
        if (response.error) throw new Error(response.error.message);
        if (!current() || !this.deps.surfaces.isCurrent(instanceId, controls)) return;
        request.opened(params);
        await controls.focus();
      } else {
        throw new Error("The editor settings have not finished loading.");
      }
    } catch (cause: unknown) {
      if (!current()) return;
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.deps.report(error);
      if (!params) return;
      const reason = `${error.message} Showing CodeMirror.`;
      request.failed?.(reason);
      request.reveal();
      request.fallback(params, reason);
    } finally {
      if (this.latest.get(request.featureId) === token) this.latest.delete(request.featureId);
    }
  }
}

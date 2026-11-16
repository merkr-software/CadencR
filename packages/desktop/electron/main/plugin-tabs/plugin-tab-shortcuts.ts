import { z } from "zod";

import {
  compileBrowserShortcutBinding,
  type BrowserShortcutInput,
  type BrowserShortcutInputMatcher,
} from "../../../src/lib/shortcuts/match-browser-input";
import type {
  PluginTabOwnShortcut,
  PluginTabShortcutBinding,
} from "../../../src/shared/plugin-tab-host";
import { shortcutBindingSchema, shortcutPlatform } from "../browser-guest-shortcuts";

/** Bounds well past the registry (~150 shortcuts) and the manifest (16 per tab). */
const MAX_APP_BINDINGS = 512;
const MAX_TAB_SHORTCUTS = 16;

const appBindingsSchema = z.array(shortcutBindingSchema).max(MAX_APP_BINDINGS);

const tabShortcutsSchema = z
  .array(
    z.object({ id: z.string().min(1).max(32), keys: shortcutBindingSchema.shape.keys }).strict(),
  )
  .max(MAX_TAB_SHORTCUTS);

export function parseAppShortcutBindings(value: unknown): PluginTabShortcutBinding[] {
  return appBindingsSchema.parse(value);
}

export function parseTabShortcuts(value: unknown): PluginTabOwnShortcut[] {
  return tabShortcutsSchema.parse(value);
}

export type PluginTabShortcutMatch = { kind: "app" } | { kind: "tab"; id: string };

/**
 * The shortcuts a focused custom tab's keys are matched against, pushed by
 * the renderer (`lib/plugin-tabs/tab-shortcuts.ts`): Cadencr's first, so a
 * tab can never take one of them, then the instance's own. Empty until the
 * renderer's first push: every key then reaches the page.
 */
export class PluginTabShortcuts {
  private app: BrowserShortcutInputMatcher[] = [];
  private readonly own = new Map<string, { id: string; matches: BrowserShortcutInputMatcher }[]>();

  constructor(private readonly platform = shortcutPlatform()) {}

  setApp(bindings: readonly PluginTabShortcutBinding[]): void {
    this.app = bindings.map((binding) => compileBrowserShortcutBinding(binding, this.platform));
  }

  setOwn(instanceId: string, shortcuts: readonly PluginTabOwnShortcut[]): void {
    if (shortcuts.length === 0) {
      this.own.delete(instanceId);
      return;
    }
    this.own.set(
      instanceId,
      shortcuts.map(({ id, keys }) => ({
        id,
        matches: compileBrowserShortcutBinding({ keys }, this.platform),
      })),
    );
  }

  forget(instanceId: string): void {
    this.own.delete(instanceId);
  }

  forgetAll(): void {
    this.own.clear();
  }

  match(instanceId: string, input: BrowserShortcutInput): PluginTabShortcutMatch | null {
    // Both sides hold Cmd/Ctrl or Alt (`appShortcutBindings`, the manifest):
    // plain typing never matches, so it skips the scan.
    if (!input.meta && !input.control && !input.alt) return null;
    if (this.app.some((matches) => matches(input))) return { kind: "app" };
    const own = this.own.get(instanceId)?.find(({ matches }) => matches(input));
    return own ? { kind: "tab", id: own.id } : null;
  }
}

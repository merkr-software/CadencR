/**
 * "Did you know?" card shown on the new-session empty state to help users
 * discover Cadencr's features. Combines two independent dimensions:
 *
 *  1. A real keyboard shortcut, pulled at random from the canonical
 *     `lib/shortcuts/registry` (single source of truth — the in-app ⌘⇧? modal
 *     reads from the same list, so additions there flow through here for
 *     free).
 *  2. A behavior tip, pulled at random from `session-hint-behaviors`.
 *
 * The two dimensions are picked independently, producing a fresh combo each
 * mount. A re-roll button lets the user cycle without sending a message.
 *
 * Visual contract (DESIGN.md, "Empty-state for the agent stream"): large
 * accent icon (28–40px is the only legal exception to the 22px icon cap),
 * muted prose, card surface with `--border`. No invented tokens.
 */
import { useState } from "react";
import { Keyboard, Lightbulb, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResolvedKbdChord } from "@/components/KbdShortcut";
import {
  SHORTCUTS_BY_SCOPE,
  type Shortcut,
  type ShortcutId,
  type ShortcutScope,
} from "@/lib/shortcuts/registry";
import { SESSION_HINT_BEHAVIORS } from "./session-hint-behaviors";
import { SessionUsageChart } from "./SessionUsageChart";

interface Hint {
  shortcut: Shortcut;
  scope: ShortcutScope;
  behavior: string;
}

function randomItem<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * One-shot pick — the two axes are independent and large (~13 scope groups ×
 * ~50 behaviors), so we just exclude the previous values from each axis and
 * trust randomness. Picking a scope first and then a shortcut from its
 * `items` keeps `(shortcut, scope)` consistent without an extra `.find()`.
 */
/** The empty state sits above the composer: teach the keys that drive it. */
const COMPOSER_SCOPES = SHORTCUTS_BY_SCOPE.filter((group) => group.scope.id === "agent");

function pickHint(prev?: Hint): Hint {
  const eligibleGroups = prev
    ? COMPOSER_SCOPES.filter((g) => g.items.length > 1 || g.items[0].id !== prev.shortcut.id)
    : COMPOSER_SCOPES;
  const group = randomItem(eligibleGroups);
  const candidates = prev ? group.items.filter((s) => s.id !== prev.shortcut.id) : group.items;
  // `candidates` is guaranteed non-empty by the `eligibleGroups` filter above.
  const shortcut = randomItem(candidates.length > 0 ? candidates : group.items);

  const eligibleBehaviors = prev
    ? SESSION_HINT_BEHAVIORS.filter((b) => b !== prev.behavior)
    : SESSION_HINT_BEHAVIORS;
  const behavior = randomItem(eligibleBehaviors);

  return { shortcut, scope: group.scope, behavior };
}

export function SessionHint() {
  const [hint, setHint] = useState<Hint>(() => pickHint());
  // Separate from `hint` because it's a remount token, not part of the
  // hint's identity. Bumping it on every cycle drives the fade animation
  // via the `key` prop on the card without polluting the data model.
  const [rerollKey, setRerollKey] = useState(0);

  const cycle = (): void => {
    setHint((prev) => pickHint(prev));
    setRerollKey((k) => k + 1);
  };

  return (
    <div className="flex w-full max-w-lg flex-col items-center gap-5">
      <div className="flex flex-col items-center gap-2 text-center">
        <div
          aria-hidden
          className="flex size-12 items-center justify-center rounded-full border border-border bg-card text-primary shadow-sm"
        >
          <Lightbulb className="size-6" strokeWidth={1.75} />
        </div>
        <h2 className="text-base font-semibold text-foreground">Start your first turn</h2>
        <p className="text-xs text-muted-foreground">A quick tip while you draft.</p>
      </div>

      <SessionUsageChart />

      <div
        key={rerollKey}
        className="w-full overflow-hidden rounded-lg border border-border bg-card shadow-sm motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-200"
      >
        <HintSection icon={<Keyboard className="size-3" aria-hidden />} label="Keyboard shortcut">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            {/* Hints are drawn from SHORTCUTS_BY_SCOPE, so the id is a registry id. */}
            <ResolvedKbdChord shortcutId={hint.shortcut.id as ShortcutId} />
            <span className="text-sm font-medium text-foreground">{hint.shortcut.description}</span>
          </div>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{hint.scope.hint}</p>
        </HintSection>

        <div className="h-px bg-border/60" role="presentation" />

        <HintSection icon={<Lightbulb className="size-3" aria-hidden />} label="Did you know?">
          <p className="text-sm leading-relaxed text-foreground">{hint.behavior}</p>
        </HintSection>
      </div>

      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={cycle}
        className="group text-muted-foreground hover:text-foreground"
      >
        <RotateCw className="transition-transform group-hover:rotate-90" aria-hidden />
        Show another tip
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function HintSection({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="px-4 py-3">
      <header className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
        {icon}
        {label}
      </header>
      {children}
    </section>
  );
}

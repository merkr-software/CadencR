/**
 * Inline keyboard shortcut badge for buttons.
 * Accepts an array of key tokens: "cmd", "shift", "enter", or any letter/symbol.
 * Renders platform-aware modifier glyphs/labels and text for letters.
 */
import { CommandIcon, CornerDownLeftIcon, ArrowUpIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useIsTabFocused } from "@/hooks/useScopedHotkeys";
import { formatCombo } from "@/lib/shortcuts/format";
import { useResolvedShortcut } from "@/lib/shortcuts/overrides";
import type { ShortcutId } from "@/lib/shortcuts/registry";
import type { TabKind } from "@/stores/feature-layout-schema";
import { formatKey, PLATFORM_IS_MAC } from "@/lib/shortcuts/format";
import { cn } from "@/lib/utils";

const ICON_SIZE = "size-2.5";
const ICON_SIZE_SM = "size-2";

function TextKeyLabel({ label, small }: { label: string; small?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-[1em] min-w-[1.75em] items-center justify-center font-mono font-semibold leading-none tracking-[-0.08em]",
        small ? "text-[0.95em]" : "text-[1em]",
      )}
    >
      {label}
    </span>
  );
}

function ShiftKeyIcon({ small }: { small?: boolean }) {
  return <ArrowUpIcon className={cn(small ? ICON_SIZE_SM : ICON_SIZE, "-translate-y-px")} />;
}

const KEY_MAP: Record<string, ReactNode> = {
  cmd: PLATFORM_IS_MAC ? (
    <CommandIcon className={ICON_SIZE} />
  ) : (
    <TextKeyLabel label={formatKey("mod")} />
  ),
  mod: PLATFORM_IS_MAC ? (
    <CommandIcon className={ICON_SIZE} />
  ) : (
    <TextKeyLabel label={formatKey("mod")} />
  ),
  ctrl: <TextKeyLabel label={formatKey("ctrl")} />,
  shift: <ShiftKeyIcon />,
  enter: <CornerDownLeftIcon className={ICON_SIZE} />,
};

const KEY_MAP_SM: Record<string, ReactNode> = {
  cmd: PLATFORM_IS_MAC ? (
    <CommandIcon className={ICON_SIZE_SM} />
  ) : (
    <TextKeyLabel label={formatKey("mod")} small />
  ),
  mod: PLATFORM_IS_MAC ? (
    <CommandIcon className={ICON_SIZE_SM} />
  ) : (
    <TextKeyLabel label={formatKey("mod")} small />
  ),
  ctrl: <TextKeyLabel label={formatKey("ctrl")} small />,
  shift: <ShiftKeyIcon small />,
  enter: <CornerDownLeftIcon className={ICON_SIZE_SM} />,
};

const VARIANT_CLASSES = {
  inline:
    "ml-2 inline-flex items-center gap-0.5 rounded border border-current/20 bg-current/10 px-2 py-1 text-[10px] font-medium leading-none text-current [&_svg]:!size-2.5",
  "inline-sm":
    "ml-1 inline-flex items-center gap-px rounded border border-current/20 bg-current/10 px-1.5 py-0.5 text-[8px] font-medium leading-none text-current [&_svg]:!size-2",
  square:
    "mr-1.5 inline-flex h-6 min-w-6 items-center justify-center rounded border border-border bg-card px-1 text-[10px] text-foreground",
  modal:
    "inline-flex items-center justify-center rounded border border-border bg-card px-2 py-1 text-[11px] font-mono font-medium text-foreground shadow-sm min-w-[24px]",
  hint: "inline-flex items-center justify-center gap-px rounded border border-current/25 bg-transparent px-1 py-0.5 text-[10px] font-mono font-medium leading-none text-current [&_svg]:!size-2.5",
} as const;

type Variant = keyof typeof VARIANT_CLASSES;

interface KbdShortcutProps {
  keys: string[];
  size?: "default" | "sm";
  variant?: Variant;
  /**
   * When set, the badge subscribes to the focused-tab state and renders a
   * muted `-` placeholder whenever the named tab isn't focused — making it
   * explicit that the keys won't fire right now.
   */
  scope?: TabKind;
  /**
   * Forces the muted `-` placeholder regardless of `scope` — for shortcuts
   * that stay registered but are temporarily inert (e.g. digit selectors
   * while a free-text input is focused).
   */
  disabled?: boolean;
}

export function KbdShortcut({
  keys,
  size = "default",
  variant,
  scope,
  disabled,
}: KbdShortcutProps) {
  const resolvedVariant = variant ?? (size === "sm" ? "inline-sm" : "inline");
  const map = size === "sm" ? KEY_MAP_SM : KEY_MAP;
  const className = VARIANT_CLASSES[resolvedVariant];

  if (disabled) {
    return <KbdPlaceholder className={className} />;
  }
  if (scope !== undefined) {
    return <ScopedKbdShortcut keys={keys} map={map} className={className} scope={scope} />;
  }
  return <KbdContent keys={keys} map={map} className={className} />;
}

function KbdPlaceholder({ className }: { className: string }) {
  return (
    <kbd className={cn(className, "opacity-50")}>
      <span className="leading-none">-</span>
    </kbd>
  );
}

interface ScopedProps {
  keys: string[];
  map: Record<string, ReactNode>;
  className: string;
  scope: TabKind;
}

// Split into its own component so unscoped badges don't subscribe to the
// feature-layout store on every render.
function ScopedKbdShortcut({ keys, map, className, scope }: ScopedProps) {
  const isActive = useIsTabFocused(scope);
  if (!isActive) {
    return <KbdPlaceholder className={className} />;
  }
  return <KbdContent keys={keys} map={map} className={className} />;
}

interface KbdContentProps {
  keys: string[];
  map: Record<string, ReactNode>;
  className: string;
}

/**
 * Badge for a registry shortcut. Resolves the combo through the override
 * store, so the hint keeps matching the binding after a user rebinds it —
 * always prefer this over hardcoding key tokens.
 */
export function ResolvedShortcutHint({ shortcutId }: { shortcutId: ShortcutId }) {
  const keys = formatCombo(useResolvedShortcut(shortcutId).keys);
  return (
    <span aria-hidden="true" className="shrink-0">
      <KbdShortcut keys={keys} variant="hint" />
    </span>
  );
}

function KbdContent({ keys, map, className }: KbdContentProps) {
  return (
    <kbd className={className}>
      {keys.map((k, i) => {
        const icon = map[k.toLowerCase()];
        return icon ? (
          <span key={i} className="inline-flex h-[1em] items-center">
            {icon}
          </span>
        ) : (
          <span key={i} className="inline-flex h-[1em] items-center leading-none">
            {k}
          </span>
        );
      })}
    </kbd>
  );
}

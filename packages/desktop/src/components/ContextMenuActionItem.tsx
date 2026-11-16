import type { ComponentProps, ComponentType, ReactNode } from "react";
import {
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { KbdKeySequence } from "@/components/kbd-key";
import { formatCombo, PLATFORM_IS_MAC } from "@/lib/shortcuts/format";
import { useResolvedShortcut } from "@/lib/shortcuts/overrides";
import type { ShortcutId, ShortcutKey } from "@/lib/shortcuts/registry";

export type ContextMenuIcon = ComponentType<{ className?: string }>;

interface ShortcutHintProps {
  shortcutId?: ShortcutId;
  shortcutKeys?: ShortcutKey[];
  destructive?: boolean;
  className?: string;
}

interface SharedActionProps extends ShortcutHintProps {
  icon?: ContextMenuIcon;
  children: ReactNode;
}

type ContextMenuActionItemProps = SharedActionProps &
  Omit<ComponentProps<typeof ContextMenuItem>, "children">;

type ContextMenuSubActionTriggerProps = SharedActionProps &
  Omit<ComponentProps<typeof ContextMenuSubTrigger>, "children">;

interface ContextMenuActionButtonProps extends SharedActionProps {
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  className?: string;
}

export function ContextMenuShortcutHint({
  shortcutId,
  shortcutKeys,
  destructive,
  className,
}: ShortcutHintProps): ReactNode {
  if (shortcutKeys) {
    return <ShortcutKeysHint keys={shortcutKeys} destructive={destructive} className={className} />;
  }
  if (shortcutId) {
    return (
      <ResolvedMenuShortcut
        shortcutId={shortcutId}
        destructive={destructive}
        className={className}
      />
    );
  }
  return null;
}

function ResolvedMenuShortcut({
  shortcutId,
  destructive,
  className,
}: {
  shortcutId: ShortcutId;
  destructive?: boolean;
  className?: string;
}): ReactNode {
  const resolved = useResolvedShortcut(shortcutId);
  return <ShortcutKeysHint keys={resolved.keys} destructive={destructive} className={className} />;
}

/** Menu-style hint: muted glyphs, same key rendering as `KbdShortcut`. */
function ShortcutKeysHint({
  keys,
  destructive,
  className,
}: {
  keys: ShortcutKey[];
  destructive?: boolean;
  className?: string;
}): ReactNode {
  if (keys.length === 0) return null;
  return (
    <ContextMenuShortcut
      className={cn(
        "inline-flex items-center gap-px tracking-normal",
        destructive && "text-destructive/70",
        className,
      )}
    >
      <KbdKeySequence keys={formatCombo(keys)} isMac={PLATFORM_IS_MAC} />
    </ContextMenuShortcut>
  );
}

export function ContextMenuActionItem({
  icon: Icon,
  children,
  shortcutId,
  shortcutKeys,
  className,
  variant,
  ...props
}: ContextMenuActionItemProps): ReactNode {
  const isDestructive = variant === "destructive";
  return (
    <ContextMenuItem variant={variant} className={className} {...props}>
      {Icon ? <Icon className="size-4" /> : null}
      <span className="min-w-0 truncate">{children}</span>
      <ContextMenuShortcutHint
        shortcutId={shortcutId}
        shortcutKeys={shortcutKeys}
        destructive={isDestructive}
      />
    </ContextMenuItem>
  );
}

export function ContextMenuSubActionTrigger({
  icon: Icon,
  children,
  shortcutId,
  shortcutKeys,
  className,
  ...props
}: ContextMenuSubActionTriggerProps): ReactNode {
  return (
    <ContextMenuSubTrigger className={className} {...props}>
      {Icon ? <Icon className="size-4" /> : null}
      <span className="min-w-0 truncate">{children}</span>
      <ContextMenuShortcutHint shortcutId={shortcutId} shortcutKeys={shortcutKeys} />
    </ContextMenuSubTrigger>
  );
}

export function ContextMenuActionButton({
  icon: Icon,
  children,
  shortcutId,
  shortcutKeys,
  destructive,
  disabled,
  className,
  onSelect,
}: ContextMenuActionButtonProps): ReactNode {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        if (!disabled) onSelect();
      }}
      className={cn(
        "relative flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none select-none",
        "hover:bg-accent focus-visible:bg-accent hover:text-accent-foreground focus-visible:text-accent-foreground",
        destructive && "text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10",
        disabled && "pointer-events-none opacity-50",
        className,
      )}
    >
      {Icon ? <Icon className="size-4 shrink-0" /> : null}
      <span className="min-w-0 truncate">{children}</span>
      <ContextMenuShortcutHint
        shortcutId={shortcutId}
        shortcutKeys={shortcutKeys}
        destructive={destructive}
      />
    </button>
  );
}

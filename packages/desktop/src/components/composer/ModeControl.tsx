import { memo, useEffect, useRef, useState, type ReactElement } from "react";
import { AlertTriangle, Check, ChevronDown } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  MODE_RISK_LABEL,
  findProviderMode,
  getVisibleModes,
  type ProviderMode,
} from "@/lib/provider-modes";
import type { RuntimeProviderModeOption } from "@/api/agentRuntime";
import type { PermissionMode } from "@/types/permission-mode";
import { useShortcutKeys } from "@/hooks/useShortcutLabel";
import { KbdShortcut } from "../KbdShortcut";

export interface ModeControlProps {
  providerId?: string;
  permissionMode?: PermissionMode;
  enabledOptInModes?: PermissionMode[];
  providerModes?: readonly RuntimeProviderModeOption[];
  /** Jump straight to a mode from the menu (the control hides without it). */
  onSelect?: (mode: PermissionMode) => void;
  /** Why the active mode won't hold with the current model, if it won't. */
  incompatibleReason?: string | null;
  /** Off where Shift+Tab isn't bound to this control (the schedule editor). */
  showShortcut?: boolean;
}

/**
 * The autonomy control of the composer's instrument row. Shows the active
 * mode in the provider's own color (the one users know from its CLI), opens a
 * menu listing every mode with a provider-neutral autonomy gloss
 * (no blind cycling), and announces every change — including Shift+Tab ones —
 * visually (a brief flash) and to screen readers.
 */
export const ModeControl = memo(function ModeControl({
  providerId,
  permissionMode,
  enabledOptInModes,
  providerModes = [],
  onSelect,
  incompatibleReason,
  showShortcut = true,
}: ModeControlProps): ReactElement | null {
  const visible = getVisibleModes(providerId, enabledOptInModes ?? [], providerModes);
  const active =
    permissionMode && visible.length >= 2
      ? (findProviderMode(providerId, permissionMode, providerModes) ?? visible[0])
      : null;
  const announcement = useModeAnnouncement(active);
  const cycleKeys = useShortcutKeys("agent-permission-mode");
  if (!active || !onSelect) return null;

  const choose = (mode: ProviderMode): void => {
    if (mode.id !== active.id) onSelect(mode.id);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-composer-mode
            data-risk={active.risk}
            key={announcement.flashKey}
            aria-label={`Mode: ${active.label}. ${MODE_RISK_LABEL[active.risk]}. ${active.description}`}
            className={cn(
              "composer-instrument min-w-0 gap-1.5",
              announcement.flashKey && "composer-mode-flash",
            )}
            style={{ color: active.tone }}
          >
            <active.icon className="size-3.5 shrink-0" />
            <span className="truncate">{active.label}</span>
            {incompatibleReason && (
              <AlertTriangle
                className="size-3.5 shrink-0 text-[var(--acc-yellow)]"
                aria-label={incompatibleReason}
              />
            )}
            <ChevronDown className="size-3 shrink-0 opacity-50" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-72 p-1">
          <DropdownMenuLabel className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
            Autonomy
            {showShortcut && <KbdShortcut keys={cycleKeys} scope="agent" />}
          </DropdownMenuLabel>
          {visible.map((mode) => (
            <DropdownMenuItem
              key={mode.id}
              onSelect={() => choose(mode)}
              className="items-start gap-2.5 py-2"
            >
              <mode.icon className="mt-0.5 size-3.5 shrink-0" style={{ color: mode.tone }} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[13px] font-medium">{mode.label}</span>
                <span className="text-xs text-muted-foreground">
                  {MODE_RISK_LABEL[mode.risk]} · {mode.description}
                </span>
              </span>
              {mode.id === active.id && <Check className="mt-0.5 size-3.5 shrink-0" />}
            </DropdownMenuItem>
          ))}
          {incompatibleReason && (
            <p className="mx-2 mt-1 mb-1.5 flex gap-1.5 text-xs text-[var(--acc-yellow)]">
              <AlertTriangle className="mt-px size-3 shrink-0" />
              {incompatibleReason}
            </p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement.text}
      </span>
    </>
  );
});

/**
 * Tracks mode changes after mount: a key that restarts the flash animation
 * and a sentence for the live region. The first render announces nothing.
 */
function useModeAnnouncement(active: ProviderMode | null): { flashKey: number; text: string } {
  const previous = useRef<string | null>(null);
  const [state, setState] = useState({ flashKey: 0, text: "" });
  const activeId = active?.id ?? null;
  const label = active?.label;
  const risk = active?.risk;
  useEffect(() => {
    if (activeId === null) return;
    if (previous.current !== null && previous.current !== activeId && label && risk) {
      setState((current) => ({
        flashKey: current.flashKey + 1,
        text: `Mode changed to ${label}: ${MODE_RISK_LABEL[risk]}`,
      }));
    }
    previous.current = activeId;
  }, [activeId, label, risk]);
  return state;
}

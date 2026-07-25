import { useState } from "react";
import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { AccessMode } from "@/types/access-mode";
import type { RuntimeProviderAccessModeOption } from "@/api/agentRuntime";
import { getAccessModeDefinition } from "./meta-bar-codex-modes";
import { META_BAR_CHIP } from "./meta-bar-chip-styles";
import { providerAccessModeConfig } from "@/lib/provider-access-modes";

interface AccessModePopoverProps {
  mode: AccessMode;
  selectedMode?: AccessMode;
  isPending?: boolean;
  onChange: (mode: AccessMode) => void;
  providerId?: string;
  options: readonly RuntimeProviderAccessModeOption[];
  /** What picking a mode here does. Defaults to the live-session wording; the
   *  schedule editor pins a mode for one rule instead of changing a running
   *  conversation and its provider default. */
  description?: string;
  /** Badge beside the current mode, for the same reason. */
  selectedHint?: string;
}

export function AccessModePopover({
  mode,
  selectedMode = mode,
  isPending = false,
  onChange,
  providerId,
  options,
  description,
  selectedHint = "New default",
}: AccessModePopoverProps): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const providerConfig = providerAccessModeConfig(providerId);
  const activeMode = getAccessModeDefinition(mode);
  const selectedAccessMode = getAccessModeDefinition(selectedMode);
  if (!activeMode || !selectedAccessMode || !providerConfig) return null;
  const activeCopy = options.find((option) => option.id === mode);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={activeCopy?.description ?? activeMode.description}
          aria-label={`${providerConfig.providerLabel} access mode: ${activeCopy?.label ?? activeMode.label}. ${activeCopy?.description ?? activeMode.description}`}
          className={cn(META_BAR_CHIP, activeMode.chipClass)}
        >
          <activeMode.icon className="size-3" />
          {activeCopy?.label ?? activeMode.label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        className="w-[360px] space-y-3 p-3 text-xs"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <div>
          <div className="text-sm font-semibold">{providerConfig.providerLabel} access mode</div>
          <p className="mt-1 text-muted-foreground">
            {description ?? (
              <>
                This conversation is using {activeCopy?.label ?? activeMode.label}. Pick a mode
                below to switch it for this conversation and set the default for new{" "}
                {providerConfig.providerLabel} conversations.
              </>
            )}
          </p>
        </div>
        <div className="space-y-1.5">
          {options.map((copy) => {
            const option = getAccessModeDefinition(copy.id);
            if (!option) return null;
            const selected = copy.id === selectedMode;
            return (
              <button
                key={copy.id}
                type="button"
                onClick={() => {
                  onChange(copy.id);
                  setOpen(false);
                }}
                disabled={isPending}
                className={cn(
                  "flex w-full items-start gap-2 rounded-md border border-transparent p-2 text-left transition-colors hover:border-border hover:bg-muted/50",
                  selected && "border-border bg-muted/60",
                  isPending && "cursor-wait opacity-60",
                )}
                aria-pressed={selected}
              >
                <option.icon className={cn("mt-0.5 size-3.5 shrink-0", option.textClass)} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 font-medium text-foreground">
                    {copy.label}
                    {selected && (
                      <>
                        <CheckIcon className="size-3 text-[var(--acc-green)]" />
                        <span className="text-[10px] font-normal text-muted-foreground">
                          {selectedHint}
                        </span>
                      </>
                    )}
                  </span>
                  <span className="mt-0.5 block leading-relaxed text-muted-foreground">
                    {copy.description ?? option.longDescription}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

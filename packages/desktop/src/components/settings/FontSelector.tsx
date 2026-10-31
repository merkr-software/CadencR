import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { useMonoFont } from "@/lib/fonts/mono-font-setting";
import { useSystemFonts } from "@/lib/fonts/useSystemFonts";
import { MONO_FONT_PREVIEW } from "@/lib/fonts/constants";
import { SettingsSubsection } from "./SettingsSubsection";
import { FontComboboxList } from "./FontComboboxList";

const DEFAULT_LABEL = "Default";

export function FontSelector(): React.JSX.Element {
  const { family, resolved, setFamily, isLoading: isSettingLoading } = useMonoFont();
  const [showAll, setShowAll] = useState(false);
  const { fonts, isLoading: isFontsLoading, error, load } = useSystemFonts();
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Surface detection failure once per error transition (never swallow).
  useEffect(() => {
    if (error) toast.error("Font detection unavailable — using the default font.");
  }, [error]);

  const isLoading = isSettingLoading || isFontsLoading;
  const currentLabel = isLoading ? "Loading…" : (family ?? DEFAULT_LABEL);

  // queryLocalFonts() requires transient user activation, so the query must
  // be kicked off from a click/toggle handler — never on mount.
  const handleOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen);
    if (nextOpen) load(showAll);
  };

  const handleShowAllChange = (nextShowAll: boolean): void => {
    setShowAll(nextShowAll);
    load(nextShowAll);
  };

  const handleSelect = (nextFamily: string): void => {
    setFamily(nextFamily);
    setOpen(false);
  };

  return (
    <SettingsSubsection>
      <div className="flex flex-col gap-3">
        <Popover open={open} onOpenChange={handleOpenChange}>
          <PopoverTrigger asChild>
            <button
              type="button"
              role="combobox"
              aria-label="Monospace font"
              aria-expanded={open}
              aria-busy={isLoading}
              disabled={isLoading}
              className="inline-flex h-8 min-w-48 items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 text-xs shadow-xs outline-none hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="truncate">{currentLabel}</span>
              <ChevronDownIcon className="size-3 opacity-70" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-64 overflow-hidden p-0"
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              window.setTimeout(() => inputRef.current?.focus(), 0);
            }}
          >
            <FontComboboxList
              inputRef={inputRef}
              fonts={fonts}
              family={family}
              onSelect={handleSelect}
            />
          </PopoverContent>
        </Popover>

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch checked={showAll} onCheckedChange={handleShowAllChange} />
          Show all fonts (not just monospace)
        </label>

        {error && (
          <p className="text-[11px] text-destructive">
            Font detection unavailable — only the default font is available.
          </p>
        )}

        <pre
          data-testid="mono-font-preview"
          className="overflow-x-auto rounded-md border border-border/70 bg-muted/40 p-3 text-xs leading-relaxed"
          style={{ fontFamily: resolved }}
        >
          {MONO_FONT_PREVIEW}
        </pre>
      </div>
    </SettingsSubsection>
  );
}

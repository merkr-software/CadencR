import { useUiTranslation } from "@/lib/i18n/ui";
import { useState } from "react";
import { Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DEFAULT_PROJECT_COLOR, PROJECT_COLORS } from "@/lib/project-colors";

/**
 * Visual project-color picker. Renders the canonical `PROJECT_COLORS`
 * palette as clickable swatches with the current selection highlighted; a
 * collapsible hex input stays for power users / paste-from-design flows.
 *
 * `value` is the hex *without* the leading `#` (the rest of the app stores
 * colors that way — see `lib/project-colors.ts`). An empty string means
 * "no override; use default".
 */
/** Strip non-hex characters, clamp to 6 chars, lowercase. Single helper so
 *  the input handler and the read-side normalization stay in lockstep. */
function sanitizeHex(raw: string): string {
  return raw
    .replace(/[^0-9a-fA-F]/g, "")
    .slice(0, 6)
    .toLowerCase();
}

export function ProjectColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}): React.JSX.Element {
  const { t } = useUiTranslation();
  const normalized = sanitizeHex(value);
  const [customOpen, setCustomOpen] = useState(false);

  const activeColor = normalized || DEFAULT_PROJECT_COLOR;
  const isPaletteMatch = PROJECT_COLORS.includes(normalized as (typeof PROJECT_COLORS)[number]);

  return (
    <div className="space-y-3">
      <div
        className="flex flex-wrap gap-1.5"
        role="radiogroup"
        aria-label={t("project.colorPicker.projectColor", "Project color")}
      >
        {PROJECT_COLORS.map((hex) => {
          const selected = hex === normalized;
          return (
            <button
              key={hex}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`#${hex}`}
              onClick={() => onChange(hex)}
              className={cn(
                "relative size-6 shrink-0 rounded-md border transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected ? "border-foreground" : "border-border/40",
              )}
              style={{ backgroundColor: `#${hex}` }}
            >
              {selected && (
                <Check
                  className="absolute inset-0 m-auto size-3.5 drop-shadow-[0_0_2px_rgba(0,0,0,0.6)]"
                  color="white"
                  strokeWidth={3}
                />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-2">
          <span
            className="inline-block size-3.5 rounded-full border border-border/60"
            style={{ backgroundColor: `#${activeColor}` }}
          />
          <span className="font-mono">#{activeColor}</span>
          {!normalized && <span>{t("project.colorPicker.default", "(default)")}</span>}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {normalized && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              onClick={() => onChange("")}
            >
              {t("common.reset", "Reset")}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => setCustomOpen((v) => !v)}
          >
            {customOpen
              ? t("project.colorPicker.hideHex", "Hide hex")
              : t("project.colorPicker.customHex", "Custom hex")}
          </Button>
        </span>
      </div>

      {customOpen && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-card p-2">
          <span className="text-[11px] text-muted-foreground">#</span>
          <Input
            placeholder="3b82f6"
            value={normalized}
            onChange={(e) => onChange(sanitizeHex(e.target.value))}
            className="h-7 w-28 font-mono text-sm"
          />
          {normalized && !isPaletteMatch && (
            <span className="text-[10px] text-muted-foreground">
              {t("project.colorPicker.custom", "Custom")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

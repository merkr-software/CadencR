import { useUiTranslation } from "@/lib/i18n/ui";
import { useState, useRef, useEffect } from "react";
import { Settings } from "lucide-react";

export interface DiffSettings {
  fontSize: "small" | "medium" | "large";
  diffMode: "split" | "unified";
  lineMode: "wrap" | "nowrap";
  highlightMode: "enable" | "disable";
  highlightEngine: "lowlight" | "shiki";
  autoLoadFullDiff: "enable" | "disable";
}

export const defaultDiffSettings: DiffSettings = {
  fontSize: "medium",
  diffMode: "unified",
  lineMode: "wrap",
  highlightMode: "enable",
  highlightEngine: "lowlight",
  autoLoadFullDiff: "disable",
};

interface DiffSettingsPopoverProps {
  settings: DiffSettings;
  onChange: (settings: DiffSettings) => void;
}

interface RadioGroupProps {
  label: string;
  value: string;
  options: { value: string; label: string; note?: string }[];
  onChange: (value: string) => void;
}

function RadioGroup({ label, value, options, onChange }: RadioGroupProps) {
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-[#bd93f9]">{label}</span>
      <div className="flex flex-wrap gap-1">
        {options.map((opt) => (
          <button
            key={opt.value}
            className={`rounded px-2 py-0.5 text-xs transition-colors ${
              value === opt.value
                ? "bg-[#44475a] text-[#f8f8f2]"
                : "text-[#6272a4] hover:text-[#f8f8f2]"
            }`}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
            {opt.note && <span className="ml-1 text-[10px] text-[#ff79c6]">{opt.note}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function DiffSettingsPopover({ settings, onChange }: DiffSettingsPopoverProps) {
  const { t } = useUiTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function update<K extends keyof DiffSettings>(key: K, value: DiffSettings[K]) {
    onChange({ ...settings, [key]: value });
  }

  return (
    <div className="relative" ref={ref}>
      <button
        className="rounded p-1 text-[#6272a4] hover:bg-[#44475a] hover:text-[#f8f8f2]"
        onClick={() => setOpen((v) => !v)}
        title={t("workspace.git.diffSettings.diffSettings", "Diff settings")}
      >
        <Settings className="h-4 w-4" />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-56 rounded-md border border-[#6272a4] bg-[#282a36] p-3 shadow-lg">
          <div className="space-y-3">
            <RadioGroup
              label={t("workspace.git.diffSettings.fontSize", "Font Size")}
              value={settings.fontSize}
              options={[
                { value: "small", label: t("workspace.git.diffSettings.small", "Small") },
                { value: "medium", label: t("workspace.git.diffSettings.medium", "Medium") },
                { value: "large", label: t("workspace.git.diffSettings.large", "Large") },
              ]}
              onChange={(v) => update("fontSize", v as DiffSettings["fontSize"])}
            />
            <RadioGroup
              label={t("workspace.git.diffSettings.diffMode", "Diff Mode")}
              value={settings.diffMode}
              options={[
                { value: "split", label: t("workspace.git.diffSettings.split", "Split") },
                { value: "unified", label: t("workspace.git.diffSettings.unified", "Unified") },
              ]}
              onChange={(v) => update("diffMode", v as DiffSettings["diffMode"])}
            />
            <RadioGroup
              label={t("workspace.git.diffSettings.lineMode", "Line Mode")}
              value={settings.lineMode}
              options={[
                { value: "wrap", label: t("workspace.git.diffSettings.wrap", "Wrap") },
                { value: "nowrap", label: t("workspace.git.diffSettings.noWrap", "No Wrap") },
              ]}
              onChange={(v) => update("lineMode", v as DiffSettings["lineMode"])}
            />
            <RadioGroup
              label={t("workspace.git.diffSettings.highlightMode", "Highlight Mode")}
              value={settings.highlightMode}
              options={[
                { value: "enable", label: t("workspace.git.diffSettings.enable", "Enable") },
                { value: "disable", label: t("workspace.git.diffSettings.disable", "Disable") },
              ]}
              onChange={(v) => update("highlightMode", v as DiffSettings["highlightMode"])}
            />
            <RadioGroup
              label={t("workspace.git.diffSettings.highlightEngine", "Highlight Engine")}
              value={settings.highlightEngine}
              options={[
                { value: "lowlight", label: "lowlight" },
                {
                  value: "shiki",
                  label: "shiki",
                  note: t("workspace.git.diffSettings.reloadReq", "(reload req.)"),
                },
              ]}
              onChange={(v) => update("highlightEngine", v as DiffSettings["highlightEngine"])}
            />
            <RadioGroup
              label={t("workspace.git.diffSettings.autoLoadFullDiff", "AutoLoad FullDiff")}
              value={settings.autoLoadFullDiff}
              options={[
                { value: "enable", label: t("workspace.git.diffSettings.enable", "Enable") },
                { value: "disable", label: t("workspace.git.diffSettings.disable", "Disable") },
              ]}
              onChange={(v) => update("autoLoadFullDiff", v as DiffSettings["autoLoadFullDiff"])}
            />
          </div>
        </div>
      )}
    </div>
  );
}

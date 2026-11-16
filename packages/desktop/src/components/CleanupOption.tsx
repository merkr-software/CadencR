import type { ReactElement, ReactNode } from "react";
import { KbdShortcut } from "@/components/KbdShortcut";
import { Checkbox } from "@/components/ui/checkbox";

interface CleanupOptionProps {
  checked: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  shortcut: string;
  description: string;
  onCheckedChange: () => void;
}

/** A bordered checkbox row used by the feature archive/delete cleanup dialogs. */
export function CleanupOption(props: CleanupOptionProps): ReactElement {
  return (
    <label
      className={`flex items-start gap-3 rounded-md border p-3 text-sm ${
        props.disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer"
      }`}
    >
      <Checkbox
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onCheckedChange}
      />
      <span className="mt-0.5 text-muted-foreground">{props.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 font-medium">
          {props.label}
          <span className="text-muted-foreground">
            <KbdShortcut keys={[props.shortcut]} variant="inline-sm" />
          </span>
        </span>
        <span className="block text-xs text-muted-foreground">{props.description}</span>
      </span>
    </label>
  );
}

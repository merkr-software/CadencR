import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useSuppressBrowserView } from "@/lib/browser-suppression";

/**
 * A select whose open list hides the native views (browser, custom tabs) for
 * as long as it is open — they paint above the DOM and would cover it.
 */
export function SuppressingSelect({
  id,
  value,
  options,
  placeholder,
  disabled,
  ariaLabel,
  onValueChange,
}: {
  id?: string;
  value: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  onValueChange: (value: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  useSuppressBrowserView(open);
  return (
    <Select
      value={value === "" ? undefined : value}
      onValueChange={onValueChange}
      open={open}
      onOpenChange={setOpen}
      disabled={disabled}
    >
      <SelectTrigger id={id} size="sm" aria-label={ariaLabel} className="w-full min-w-0 sm:w-64">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

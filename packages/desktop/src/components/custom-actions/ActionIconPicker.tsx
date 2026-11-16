import { useRef, useState, type ReactElement } from "react";
import { ImageUpIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { ACTION_ICONS, actionMonogram, isImageIcon, lucideIconValue } from "./action-icons";

const ACCEPTED_MIME = ["image/png", "image/jpeg", "image/svg+xml", "image/gif"];
/** Mirrors the service's `MAX_ICON_BYTES` (base64 inflates by a third). */
const MAX_FILE_BYTES = 384 * 1024;

const OPTION_CLASS =
  "flex size-8 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-checked:border-border aria-checked:bg-accent aria-checked:text-foreground";

interface ActionIconPickerProps {
  id: string;
  name: string;
  value: string | null;
  onChange: (value: string | null) => void;
}

/** A glyph, the action's monogram (no icon), or an uploaded image. */
export function ActionIconPicker({
  id,
  name,
  value,
  onChange,
}: ActionIconPickerProps): ReactElement {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const readFile = (file: File): void => {
    if (!ACCEPTED_MIME.includes(file.type)) {
      setFileError("Use a PNG, JPEG, GIF or SVG image.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setFileError("Use an image under 384 KB.");
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setFileError("The image could not be read.");
    reader.onload = () => {
      if (typeof reader.result !== "string") return;
      setFileError(null);
      onChange(reader.result);
    };
    reader.readAsDataURL(file);
  };
  return (
    <div className="space-y-1.5">
      <div id={id} role="radiogroup" aria-label="Icon" className="flex flex-wrap gap-1">
        <button
          type="button"
          role="radio"
          aria-checked={value == null}
          aria-label="Monogram"
          title="Monogram"
          onClick={() => onChange(null)}
          className={cn(OPTION_CLASS, "text-[10px] font-semibold")}
        >
          {actionMonogram(name || "Action")}
        </button>
        {Object.entries(ACTION_ICONS).map(([key, Glyph]) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={value === lucideIconValue(key)}
            aria-label={key}
            title={key}
            onClick={() => onChange(lucideIconValue(key))}
            className={OPTION_CLASS}
          >
            <Glyph className="size-4" aria-hidden />
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={isImageIcon(value)}
          aria-label="Upload an image"
          title="Upload an image"
          onClick={() => fileRef.current?.click()}
          className={OPTION_CLASS}
        >
          {isImageIcon(value) ? (
            <img src={value} alt="" className="size-4 object-contain" />
          ) : (
            <ImageUpIcon className="size-4" aria-hidden />
          )}
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPTED_MIME.join(",")}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) readFile(file);
          event.target.value = "";
        }}
      />
      {fileError && (
        <p role="alert" className="text-xs text-destructive">
          {fileError}
        </p>
      )}
    </div>
  );
}

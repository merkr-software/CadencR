import { useRef } from "react";
import { Paperclip } from "lucide-react";
import { useCatalogProviderMetadata } from "@/hooks/useCatalogProviderMetadata";
import { attachmentAcceptForProvider } from "@/lib/prompt-attachments";

interface ImageAttachmentButtonProps {
  onFilesSelected: (files: FileList | File[]) => void;
  disabled?: boolean;
  providerId?: string;
}

export function ImageAttachmentButton({
  onFilesSelected,
  disabled,
  providerId,
}: ImageAttachmentButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const promptCapabilities = useCatalogProviderMetadata(providerId)?.promptCapabilities ?? null;

  const handleClick = () => {
    inputRef.current?.click();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFilesSelected(e.target.files);
      // Reset so same files can be selected again
      e.target.value = "";
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={attachmentAcceptForProvider(providerId, promptCapabilities)}
        multiple
        className="hidden"
        onChange={handleChange}
      />
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        aria-label="Attach files"
        className="composer-instrument composer-instrument-icon text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        <Paperclip className="size-3.5" />
      </button>
    </>
  );
}

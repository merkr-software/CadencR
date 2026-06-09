import { FileText, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { isImageAttachment, type PromptAttachment } from "@/lib/prompt-attachments";

interface ImageAttachmentPreviewProps {
  attachments: PromptAttachment[];
  onRemove: (id: string) => void;
  className?: string;
}

function RemoveButton({ fileName, onRemove }: { fileName: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
      aria-label={`Remove ${fileName}`}
    >
      <X className="w-2.5 h-2.5" />
    </button>
  );
}

export function ImageAttachmentPreview({
  attachments,
  onRemove,
  className,
}: ImageAttachmentPreviewProps) {
  if (attachments.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap gap-2 p-2", className)}>
      {attachments.map((attachment) => (
        <div key={attachment.id} className="relative group">
          {isImageAttachment(attachment) ? (
            <img
              src={attachment.previewUrl}
              alt={attachment.fileName}
              className="w-12 h-12 rounded object-cover border border-border"
            />
          ) : (
            <div
              className="flex h-12 max-w-[12rem] items-center gap-2 rounded border border-border bg-muted/40 px-2.5"
              title={attachment.fileName}
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate text-xs text-foreground">{attachment.fileName}</span>
            </div>
          )}
          <RemoveButton fileName={attachment.fileName} onRemove={() => onRemove(attachment.id)} />
        </div>
      ))}
    </div>
  );
}

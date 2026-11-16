import type { ComponentType, ReactElement, RefObject } from "react";
import {
  ChevronDownIcon,
  ClipboardCopyIcon,
  FileTextIcon,
  MailIcon,
  MessageSquareIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsTouchDevice } from "@/hooks/useIsTouchDevice";
import { rangeToEmailHtml } from "@/lib/email-export";
import { copyAs, type ExportFormat } from "@/lib/markdown-export";

/** "Copy as" choices, shared with the desktop right-click block menu. */
export const COPY_AS_FORMATS: {
  format: ExportFormat;
  label: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  { format: "markdown", label: "Markdown", icon: FileTextIcon },
  { format: "slack", label: "Slack mrkdwn", icon: MessageSquareIcon },
  { format: "plain", label: "Plain text", icon: ClipboardCopyIcon },
  { format: "email", label: "Email", icon: MailIcon },
];

interface CopyAsMenuProps {
  /** Message source, copied as-is or converted per format. */
  content: string;
  /** Rendered message body, serialized for the rich email format. */
  sourceRef: RefObject<HTMLElement | null>;
}

/**
 * Touch-only "Copy as" dropdown for a message's action row. On desktop the
 * same formats live in the right-click block menu, which touch devices don't
 * get (see `useTouchSafeTriggerProps`).
 */
export function CopyAsMenu({ content, sourceRef }: CopyAsMenuProps): ReactElement | null {
  const isTouch = useIsTouchDevice();
  if (!isTouch) return null;

  const copy = (format: ExportFormat): void => {
    let emailHtml: string | undefined;
    if (format === "email" && sourceRef.current) {
      const range = document.createRange();
      range.selectNodeContents(sourceRef.current);
      emailHtml = rangeToEmailHtml(range);
    }
    void copyAs(format, content, emailHtml);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
        >
          <span>Copy as</span>
          <ChevronDownIcon className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {COPY_AS_FORMATS.map(({ format, label, icon: Icon }) => (
          <DropdownMenuItem key={format} onSelect={() => copy(format)}>
            <Icon className="size-4" />
            {label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import { translateUi, useUiTranslation } from "@/lib/i18n/ui";
import type { ComponentType, ReactElement, RefObject } from "react";
import {
  ChevronDownIcon,
  ClipboardCopyIcon,
  FileTextIcon,
  MailIcon,
  MessageSquareIcon,
} from "lucide-react";
import {
  AdaptiveMenu,
  AdaptiveMenuContent,
  AdaptiveMenuItem,
  AdaptiveMenuTrigger,
} from "@/components/PhoneSheetMenu";
import { useIsTouchDevice } from "@/hooks/useIsTouchDevice";
import { rangeToEmailHtml } from "@/lib/email-export";
import { copyAs, type ExportFormat } from "@/lib/markdown-export";

/** "Copy as" choices, shared with the desktop right-click block menu. */
export const COPY_AS_FORMATS: {
  format: ExportFormat;
  label: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  {
    format: "markdown",
    get label() {
      return translateUi("conversation.stream.copyAsMenu.markdown", "Markdown");
    },
    icon: FileTextIcon,
  },
  {
    format: "slack",
    get label() {
      return translateUi("conversation.stream.copyAsMenu.slack", "Slack mrkdwn");
    },
    icon: MessageSquareIcon,
  },
  {
    format: "plain",
    get label() {
      return translateUi("conversation.stream.copyAsMenu.plain", "Plain text");
    },
    icon: ClipboardCopyIcon,
  },
  {
    format: "email",
    get label() {
      return translateUi("conversation.stream.copyAsMenu.email", "Email");
    },
    icon: MailIcon,
  },
];

/**
 * Copy a message in `format`; the email format serializes the rendered
 * `sourceRef` element. `copyAs` confirms with a toast (or reports the error).
 */
export function copyMessageAs(
  format: ExportFormat,
  content: string,
  sourceRef: RefObject<HTMLElement | null>,
): void {
  let emailHtml: string | undefined;
  if (format === "email" && sourceRef.current) {
    const range = document.createRange();
    range.selectNodeContents(sourceRef.current);
    emailHtml = rangeToEmailHtml(range);
  }
  void copyAs(format, content, emailHtml);
}

/**
 * One menu row per format, for `AdaptiveMenuContent`: the Copy as menu lists
 * them all, a message's phone sheet those after its plain Copy. `getContent`
 * is read on the pick, so a streaming message hands over its latest text.
 */
export function CopyAsItems({
  formats = COPY_AS_FORMATS,
  getContent,
  sourceRef,
}: {
  formats?: typeof COPY_AS_FORMATS;
  getContent: () => string;
  sourceRef: RefObject<HTMLElement | null>;
}): ReactElement {
  return (
    <>
      {formats.map(({ format, label, icon: Icon }) => (
        <AdaptiveMenuItem
          key={format}
          onSelect={() => copyMessageAs(format, getContent(), sourceRef)}
        >
          <Icon className="size-4" />
          {label}
        </AdaptiveMenuItem>
      ))}
    </>
  );
}

interface CopyAsMenuProps {
  /** Message source, copied as-is or converted per format. */
  content: string;
  /** Rendered message body, serialized for the rich email format. */
  sourceRef: RefObject<HTMLElement | null>;
}

/**
 * Touch-only "Copy as" menu for a message's action row (a sheet in the phone layout). On desktop the
 * same formats live in the right-click block menu, which touch devices don't
 * get (see `useTouchSafeTriggerProps`).
 */
export function CopyAsMenu({ content, sourceRef }: CopyAsMenuProps): ReactElement | null {
  const { t } = useUiTranslation();
  const isTouch = useIsTouchDevice();
  if (!isTouch) return null;

  return (
    <AdaptiveMenu>
      <AdaptiveMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
        >
          <span>{t("conversation.stream.copyAsMenu.copyAs", "Copy as")}</span>
          <ChevronDownIcon className="size-3" />
        </button>
      </AdaptiveMenuTrigger>
      <AdaptiveMenuContent align="start" sheetTitle="Copy as" sheetTitleVisible>
        <CopyAsItems getContent={() => content} sourceRef={sourceRef} />
      </AdaptiveMenuContent>
    </AdaptiveMenu>
  );
}

import { useUiTranslation } from "@/lib/i18n/ui";
import { CodeIcon, EyeIcon } from "lucide-react";
import { HEADER_BUTTON_CLASS } from "@/components/CodeBlockHeader";

interface SourceToggleProps {
  showingSource: boolean;
  /** What the rendered view is called: "Diagram", "Chart", "Preview". */
  renderedLabel: string;
  onToggle: () => void;
}

/** Header action swapping a rendered block (diagram, chart, visual) with its source. */
export function SourceToggle({ showingSource, renderedLabel, onToggle }: SourceToggleProps) {
  const { t } = useUiTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      className={HEADER_BUTTON_CLASS}
      title={
        showingSource
          ? t("conversation.stream.sourceToggle.viewRendered", "View {{label}}", {
              label: renderedLabel.toLocaleLowerCase(),
            })
          : t("conversation.stream.sourceToggle.viewSource", "View source")
      }
    >
      {showingSource ? (
        <>
          <EyeIcon className="size-3" />
          <span>{renderedLabel}</span>
        </>
      ) : (
        <>
          <CodeIcon className="size-3" />
          <span>{t("conversation.stream.sourceToggle.source", "Source")}</span>
        </>
      )}
    </button>
  );
}

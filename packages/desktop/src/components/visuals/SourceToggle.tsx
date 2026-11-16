import { CodeIcon, EyeIcon } from "lucide-react";

interface SourceToggleProps {
  showingSource: boolean;
  /** What the rendered view is called: "Diagram", "Chart", "Preview". */
  renderedLabel: string;
  onToggle: () => void;
}

/** Header action swapping a rendered block (diagram, chart, visual) with its source. */
export function SourceToggle({ showingSource, renderedLabel, onToggle }: SourceToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-foreground/70 hover:bg-accent hover:text-foreground transition-colors"
      title={showingSource ? `View ${renderedLabel.toLowerCase()}` : "View source"}
    >
      {showingSource ? (
        <>
          <EyeIcon className="size-3" />
          <span>{renderedLabel}</span>
        </>
      ) : (
        <>
          <CodeIcon className="size-3" />
          <span>Source</span>
        </>
      )}
    </button>
  );
}

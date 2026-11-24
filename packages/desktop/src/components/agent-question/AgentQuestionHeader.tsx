import { memo } from "react";
import { useUiTranslation } from "@/lib/i18n/ui";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GateLaterButton } from "@/components/GatePhoneActions";
import { MessageCircleQuestionIcon, ChevronLeftIcon, ChevronRightIcon, X } from "lucide-react";

interface AgentQuestionHeaderProps {
  questionsLength: number;
  currentIndex: number;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onCancel?: () => void;
  /** Phone layout: "Later" in place of the close button, which stops the agent. */
  onLater?: () => void;
}

/** Progress indicator (multi-question) + dismiss X (or "Later" on phone) for the agent question drawer. */
function AgentQuestionHeaderComponent({
  questionsLength,
  currentIndex,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onCancel,
  onLater,
}: AgentQuestionHeaderProps) {
  const { t } = useUiTranslation();
  return (
    <div className="mb-2 flex items-center gap-1 text-xs text-muted-foreground">
      {questionsLength > 1 && (
        <>
          <button
            type="button"
            disabled={!canGoBack}
            onClick={onBack}
            className={cn(
              "inline-flex size-5 items-center justify-center rounded hover:bg-muted/50 transition-colors",
              canGoBack ? "text-foreground cursor-pointer" : "opacity-30 cursor-default",
            )}
            aria-label={t("question.previous", "Previous question")}
          >
            <ChevronLeftIcon className="size-3.5" />
          </button>
          <MessageCircleQuestionIcon className="size-3" />
          <span>
            {t("question.progress", "Question {{index}} of {{total}}", {
              index: currentIndex + 1,
              total: questionsLength,
            })}
          </span>
          <button
            type="button"
            disabled={!canGoForward}
            onClick={onForward}
            className={cn(
              "inline-flex size-5 items-center justify-center rounded hover:bg-muted/50 transition-colors",
              canGoForward ? "text-foreground cursor-pointer" : "opacity-30 cursor-default",
            )}
            aria-label={t("question.next", "Next question")}
          >
            <ChevronRightIcon className="size-3.5" />
          </button>
        </>
      )}
      {onLater && <GateLaterButton onLater={onLater} />}
      {onCancel && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={onCancel}
          aria-label={t("question.dismiss", "Dismiss question (Esc)")}
          title={t("question.dismissTooltip", "Dismiss (Esc) - stops the agent")}
          className="ml-auto size-5 text-muted-foreground"
        >
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

export const AgentQuestionHeader = memo(AgentQuestionHeaderComponent);

import { useUiTranslation } from "@/lib/i18n/ui";
import { cn } from "@/lib/utils";
import { ClipboardCheck, CircleCheckIcon, CircleXIcon } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { parseToolArgsObject, stringArg } from "@/lib/tool-args";

export function PlanBlock({
  args,
  approvalStatus,
}: {
  args?: string;
  approvalStatus?: "approved" | "rejected";
}) {
  const { t } = useUiTranslation();
  const plan = stringArg(parseToolArgsObject(args), "plan");

  if (!plan) return null;

  return (
    <div className="my-2 rounded-md border border-[var(--block-plan-accent)]/30 bg-[var(--block-plan-bg)]">
      <div className="flex items-center gap-2 border-b border-[var(--block-plan-accent)]/30 px-3 py-1.5 text-xs">
        <ClipboardCheck className="size-3 text-[var(--block-plan-accent)]" />
        <span className="font-medium text-[var(--block-plan-accent)]">
          {t("conversation.stream.planBlock.plan", "Plan")}
        </span>
      </div>
      <div className="px-3 py-2">
        <Markdown content={plan} />
      </div>
      {approvalStatus && (
        <div
          className={cn(
            "flex items-center gap-1.5 border-t px-3 py-1.5 text-xs font-medium",
            approvalStatus === "approved"
              ? "border-[var(--acc-green)]/40 text-[var(--acc-green)]"
              : "border-destructive/40 text-destructive",
          )}
        >
          {approvalStatus === "approved" ? (
            <>
              <CircleCheckIcon className="size-3" />{" "}
              {t("conversation.stream.planBlock.approved", "Approved")}
            </>
          ) : (
            <>
              <CircleXIcon className="size-3" />{" "}
              {t("conversation.stream.planBlock.rejected", "Rejected")}
            </>
          )}
        </div>
      )}
    </div>
  );
}

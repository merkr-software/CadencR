import type { ReactElement } from "react";
import { CircleDashedIcon } from "lucide-react";

/**
 * A pane with nothing to show yet: an icon tile, a title, one sentence and an
 * optional action (the PR tab, a custom tab's overlay, the agents grid).
 */
export function EmptyState({
  title,
  description,
  detail,
  action,
  icon,
}: {
  title: string;
  description: string;
  /**
   * Verbatim explanation from a forge, shown under the description. Clamped
   * because it is not always a sentence — a rejected request can come back as a
   * page of JSON, which would otherwise read as the card's own copy.
   */
  detail?: string | null;
  action?: ReactElement;
  icon?: ReactElement;
}): ReactElement {
  return (
    <div className="grid h-full place-items-center px-6 py-10 text-center">
      <div className="max-w-[18rem] space-y-3">
        <div className="mx-auto grid size-10 place-items-center rounded-md border border-border bg-card text-muted-foreground">
          {icon ?? <CircleDashedIcon className="size-5" aria-hidden />}
        </div>
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-balance text-foreground">{title}</h2>
          <p className="text-[12.5px] leading-relaxed text-pretty text-muted-foreground">
            {description}
          </p>
          {detail ? (
            <p className="line-clamp-3 text-[11.5px] leading-relaxed text-pretty text-muted-foreground/70">
              {detail}
            </p>
          ) : null}
        </div>
        {action ? <div className="pt-1">{action}</div> : null}
      </div>
    </div>
  );
}

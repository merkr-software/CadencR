import { useUiTranslation, UiTrans } from "@/lib/i18n/ui";
import { Loader2Icon, SendIcon } from "lucide-react";
import { useMemo, type ReactElement } from "react";
import { KbdShortcut } from "@/components/KbdShortcut";
import { ShortcutTooltip } from "@/components/ShortcutTooltip";
import { Button } from "@/components/ui/button";
import { formatCombo } from "@/lib/shortcuts/format";
import { useResolvedShortcut } from "@/lib/shortcuts/overrides";

export interface GitSendCommentsBarProps {
  /** Local draft comments. Omitted when there are none to send. */
  drafts?: { label: string; disabled: boolean; sending: boolean; onSend: () => void };
  /** Unresolved review threads pulled from the forge. */
  reviews?: {
    selectedCount: number;
    totalCount: number;
    disabled: boolean;
    onSend: () => void;
    onClear: () => void;
  };
}

/**
 * The one place the Git tab hands work to the agent. Local drafts and the
 * forge's unresolved review threads stay separate buttons on purpose: they are
 * different bodies of feedback with different provenance, and a developer
 * usually wants to send exactly one of them.
 *
 * With nothing picked the bar teaches the two ways to pick rather than
 * reporting "0 of 8" — a count of zero is not news, and the keys are the part
 * nobody finds on their own.
 */
export function GitSendCommentsBar({
  drafts,
  reviews,
}: GitSendCommentsBarProps): ReactElement | null {
  const { t } = useUiTranslation();
  const reviewShortcut = useResolvedShortcut("diff-send-review-comments");
  const pickShortcut = useResolvedShortcut("git-toggle-thread-picked");
  const draftShortcut = useResolvedShortcut("diff-send-comments");
  const reviewKeys = useMemo(() => formatCombo(reviewShortcut.keys), [reviewShortcut.keys]);
  const pickKeys = useMemo(() => formatCombo(pickShortcut.keys), [pickShortcut.keys]);
  const draftKeys = useMemo(() => formatCombo(draftShortcut.keys), [draftShortcut.keys]);
  if (!drafts && !reviews) return null;
  return (
    <div className="flex min-h-13 items-center justify-end gap-2 border-t border-border bg-card/30 px-4 py-2.5">
      {reviews && (
        <>
          <span
            className="mr-auto inline-flex min-w-0 items-center gap-1.5 text-[11.5px] text-foreground"
            aria-live="polite"
          >
            {reviews.selectedCount > 0 ? (
              <span className="tabular-nums">
                <UiTrans
                  i18nKey="workspace.git.gitSendCommentsBar.pickedCount"
                  defaults="<selected>{{selected, number}}</selected> of {{total, number}} picked"
                  values={{ selected: reviews.selectedCount, total: reviews.totalCount }}
                  components={{ selected: <span className="font-medium text-foreground" /> }}
                />
              </span>
            ) : (
              <>
                <span className="truncate">
                  {t("workspace.git.gitSendCommentsBar.pickThreadsToSend", "Pick threads to send")}
                </span>
                <KbdShortcut keys={pickKeys} size="sm" />
              </>
            )}
          </span>
          {reviews.selectedCount > 0 && (
            <Button variant="ghost" size="sm" onClick={reviews.onClear}>
              {t("workspace.git.gitSendCommentsBar.clear", "Clear")}
            </Button>
          )}
          <ShortcutTooltip
            label={t(
              "workspace.git.gitSendCommentsBar.sendPickedThreadsToTheAgent",
              "Send picked threads to the agent",
            )}
            keys={reviewKeys}
            above
          >
            <span className="inline-flex">
              <Button size="sm" disabled={reviews.disabled} onClick={reviews.onSend}>
                <SendIcon className="size-3.5" aria-hidden />
                {reviews.selectedCount > 0
                  ? t(
                      "workspace.git.gitSendCommentsBar.sendCountToAgent",
                      "Send {{count, number}} to agent",
                      { count: reviews.selectedCount },
                    )
                  : t("workspace.git.gitSendCommentsBar.sendToAgent", "Send to agent")}
              </Button>
            </span>
          </ShortcutTooltip>
        </>
      )}
      {drafts && (
        <ShortcutTooltip label={drafts.label} keys={draftKeys} above>
          <Button variant="outline" size="sm" disabled={drafts.disabled} onClick={drafts.onSend}>
            {drafts.sending ? (
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <SendIcon className="size-3.5" aria-hidden />
            )}
            {drafts.label}
          </Button>
        </ShortcutTooltip>
      )}
    </div>
  );
}

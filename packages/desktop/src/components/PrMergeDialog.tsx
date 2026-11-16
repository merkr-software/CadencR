import { useEffect, useRef, useState, type ReactElement } from "react";
import { GitMerge, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  usePostPrMerge,
  type MergeAction,
  type MergeMethod,
  type PrMergeRequest,
  type PrMergeStatus,
  type PrSummary,
} from "@/api/generated";
import { useDialogSubmitShortcut } from "@/components/git-actions/useDialogSubmitShortcut";
import { PrViewError } from "@/components/FeaturePrViewParts";
import { KbdShortcut } from "@/components/KbdShortcut";
import { RadioCardGroup, type RadioCardOption } from "@/components/settings/RadioCardGroup";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiErrorMessage } from "@/lib/api-errors";
import {
  MERGE_METHOD_DESCRIPTION,
  MERGE_METHOD_LABEL,
  mergeActionExplanation,
  mergeActionLabel,
  mergeOutcomeMessage,
} from "@/lib/pr-merge";

const ESC_KEYS: string[] = ["esc"];
const SUBMIT_KEYS: string[] = ["cmd", "enter"];

interface PrMergeDialogProps {
  featureId: number;
  pr: PrSummary;
  status: PrMergeStatus;
  action: MergeAction;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called once the forge accepted the request. */
  onDone: () => void;
}

/**
 * The confirmation in front of a forge merge. Merging is outward-facing and
 * not undoable from here, so the click on the band only opens this — the
 * method and the branch clean-up are decided where they can be read.
 */
export function PrMergeDialog({
  featureId,
  pr,
  status,
  action,
  open,
  onOpenChange,
  onDone,
}: PrMergeDialogProps): ReactElement {
  const queued = action === "enqueue" || action === "enqueue_when_ready";
  const [method, setMethod] = useState<MergeMethod | null>(null);
  const [deleteBranch, setDeleteBranch] = useState<boolean | null>(null);
  // The head on screen when the dialog opened. A push while it is open
  // refreshes `status`, but the merge stays pinned to what was confirmed.
  const [confirmedSha, setConfirmedSha] = useState(status.head_sha);
  const effectiveMethod = method ?? status.default_method ?? status.methods[0] ?? null;
  const effectiveDelete = deleteBranch ?? status.delete_source_branch.default;
  const moved = status.head_sha !== confirmedSha;
  const { submit, submitting, error } = useMergeSubmit({
    request: {
      feature_id: featureId,
      pr_number: pr.number,
      action,
      method: queued ? null : effectiveMethod,
      delete_source_branch: effectiveDelete,
      expected_head_sha: confirmedSha,
    },
    status,
    blocked: moved,
    onSuccess: () => {
      onOpenChange(false);
      onDone();
    },
  });

  // Esc and the overlay would drop the dialog — and the forge's answer with it.
  const handleOpenChange = (next: boolean): void => {
    if (next || !submitting) onOpenChange(next);
  };

  useDialogSubmitShortcut({ open, onSubmit: () => void submit() });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent onOpenAutoFocus={(event) => event.preventDefault()} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitMerge className="size-5" aria-hidden />
            {mergeActionLabel(action, status)} #{pr.number}
          </DialogTitle>
          <DialogDescription>{mergeActionExplanation(action, status)}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1 rounded-md border p-3 text-sm">
            <p className="line-clamp-2 font-medium text-foreground">{pr.title}</p>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {pr.source_branch} → {pr.target_branch}
            </p>
          </div>
          {!queued && effectiveMethod && (
            <MethodPicker
              methods={status.methods}
              value={effectiveMethod}
              disabled={submitting}
              onChange={setMethod}
            />
          )}
          <DeleteBranchOption
            status={status}
            deferred={action !== "merge"}
            checked={effectiveDelete}
            disabled={submitting}
            onChange={setDeleteBranch}
          />
          {moved && (
            <MovedHeadNotice
              sha={status.head_sha}
              disabled={submitting}
              onAccept={() => setConfirmedSha(status.head_sha)}
            />
          )}
          {error && <PrViewError message={error} compact />}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
            <KbdShortcut keys={ESC_KEYS} variant="hint" />
          </Button>
          <Button onClick={() => void submit()} disabled={submitting || moved}>
            {submitting && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {queued || !effectiveMethod || action !== "merge"
              ? mergeActionLabel(action, status)
              : MERGE_METHOD_LABEL[effectiveMethod]}
            <KbdShortcut keys={SUBMIT_KEYS} variant="hint" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Sends the confirmed merge once. A ref guards it: a held ⌘↵ fires again
 * before `isPending` re-renders.
 */
function useMergeSubmit({
  request,
  status,
  blocked,
  onSuccess,
}: {
  request: PrMergeRequest;
  status: PrMergeStatus;
  blocked: boolean;
  onSuccess: () => void;
}): { submit: () => Promise<void>; submitting: boolean; error: string | null } {
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const merge = usePostPrMerge();
  async function submit(): Promise<void> {
    if (inFlight.current || blocked) return;
    inFlight.current = true;
    setError(null);
    try {
      const result = await merge.mutateAsync({ data: request });
      toast.success(mergeOutcomeMessage(result.outcome, status));
      if (result.warning) toast.warning(result.warning);
      onSuccess();
    } catch (err) {
      const message = apiErrorMessage(err, "The forge refused the merge");
      // The dialog may be gone (the pane moved to another proposal); the
      // refusal still has to reach the user.
      if (mounted.current) setError(message);
      else toast.error(message);
    } finally {
      inFlight.current = false;
    }
  }
  return { submit, submitting: merge.isPending, error };
}

function MethodPicker({
  methods,
  value,
  disabled,
  onChange,
}: {
  methods: MergeMethod[];
  value: MergeMethod;
  disabled: boolean;
  onChange: (next: MergeMethod) => void;
}): ReactElement {
  if (methods.length <= 1) {
    return (
      <p className="text-sm text-muted-foreground">
        {MERGE_METHOD_LABEL[value]} — the only method this branch allows.
      </p>
    );
  }
  const options: RadioCardOption<MergeMethod>[] = methods.map((method) => ({
    value: method,
    label: MERGE_METHOD_LABEL[method],
    description: MERGE_METHOD_DESCRIPTION[method],
  }));
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">Merge method</div>
      <RadioCardGroup<MergeMethod>
        ariaLabel="Merge method"
        value={value}
        onChange={onChange}
        options={options}
        showDot={false}
        disabled={disabled}
      />
    </div>
  );
}

function MovedHeadNotice({
  sha,
  disabled,
  onAccept,
}: {
  sha: string;
  disabled: boolean;
  onAccept: () => void;
}): ReactElement {
  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <p className="min-w-0 flex-1">
        New commits were pushed while this was open. The branch is now at{" "}
        <span className="font-mono">{sha.slice(0, 7)}</span>.
      </p>
      <Button size="xs" variant="outline" disabled={disabled} onClick={onAccept}>
        Use the new head
      </Button>
    </div>
  );
}

function DeleteBranchOption({
  status,
  deferred,
  checked,
  disabled,
  onChange,
}: {
  status: PrMergeStatus;
  /** The merge happens later, without Cadencr — auto-merge or a queue. */
  deferred: boolean;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}): ReactElement | null {
  const { configurable, default: byDefault } = status.delete_source_branch;
  // Where the forge cannot carry the choice to a later merge, the repository
  // setting decides; the server applies it either way.
  if (!configurable || (deferred && !status.delete_source_branch.deferred)) {
    return byDefault ? (
      <p className="text-xs text-muted-foreground">
        The repository deletes the source branch after it merges.
      </p>
    ) : null;
  }
  return (
    <label className="flex items-center gap-2 text-sm">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onChange(next === true)}
      />
      Delete the source branch after merging
    </label>
  );
}

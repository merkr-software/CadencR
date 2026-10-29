import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  getGetCustomActionScheduleQueryKey,
  useGetCustomActionSchedule,
  useSetCustomActionSchedule,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";

type Unit = "seconds" | "minutes" | "hours";

const UNIT_SECONDS: Record<Unit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
};

const MIN_INTERVAL_SECONDS = 5;

interface CustomActionScheduleControlProps {
  actionId: number;
  featureId: number;
}

interface UnitValue {
  value: number;
  unit: Unit;
}

/**
 * Pick the largest unit that yields a whole-number value, so a 180-second
 * schedule reads back as "3 minutes" rather than "180 seconds". Falls back
 * to seconds when nothing divides evenly.
 */
function intervalToUnitValue(intervalSeconds: number): UnitValue {
  if (intervalSeconds >= UNIT_SECONDS.hours && intervalSeconds % UNIT_SECONDS.hours === 0) {
    return { value: intervalSeconds / UNIT_SECONDS.hours, unit: "hours" };
  }
  if (intervalSeconds >= UNIT_SECONDS.minutes && intervalSeconds % UNIT_SECONDS.minutes === 0) {
    return { value: intervalSeconds / UNIT_SECONDS.minutes, unit: "minutes" };
  }
  return { value: intervalSeconds, unit: "seconds" };
}

const DEFAULT_DRAFT: UnitValue = { value: 5, unit: "minutes" };

function ScheduleIntervalEditor({
  draft,
  setDraft,
  commit,
}: {
  draft: UnitValue;
  setDraft: Dispatch<SetStateAction<UnitValue>>;
  commit: (next: UnitValue) => void;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-2 text-xs" aria-label="Schedule interval">
      <span className="text-foreground/70">Every</span>
      <Input
        type="number"
        min={1}
        step={1}
        value={String(draft.value)}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed) && parsed > 0) {
            setDraft((current) => ({ ...current, value: parsed }));
          }
        }}
        onBlur={() => commit(draft)}
        className="h-8 w-16 text-xs no-spinner"
      />
      <Select
        value={draft.unit}
        onValueChange={(value) => {
          const next = { ...draft, unit: value as Unit };
          setDraft(next);
          commit(next);
        }}
      >
        <SelectTrigger size="sm" className="h-8 w-[7rem] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="seconds">seconds</SelectItem>
          <SelectItem value="minutes">minutes</SelectItem>
          <SelectItem value="hours">hours</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

export function CustomActionScheduleControl({
  actionId,
  featureId,
}: CustomActionScheduleControlProps) {
  const queryClient = useQueryClient();
  const { data: schedule, isLoading } = useGetCustomActionSchedule(actionId, {
    feature_id: featureId,
  });

  // Local draft state: what the user is currently typing/picking. We commit
  // it to the backend on blur or unit change, then let the refetched query
  // become the source of truth (no optimistic updates).
  const [draft, setDraft] = useState<UnitValue>(DEFAULT_DRAFT);

  useEffect(() => {
    if (schedule) {
      setDraft(intervalToUnitValue(schedule.interval_seconds));
    }
  }, [schedule]);

  const mutation = useSetCustomActionSchedule({
    mutation: {
      onSuccess: (_data, vars) => {
        queryClient.invalidateQueries({
          queryKey: getGetCustomActionScheduleQueryKey(vars.id, vars.params),
        });
      },
      onError: (err) => toast.error(`Scheduling failed: ${apiErrorMessage(err, "unknown error")}`),
    },
  });

  const enabled = !!schedule && schedule.enabled;

  function commit(next: UnitValue): void {
    const intervalSeconds = next.value * UNIT_SECONDS[next.unit];
    if (intervalSeconds < MIN_INTERVAL_SECONDS) {
      toast.error(`Minimum interval is ${MIN_INTERVAL_SECONDS} seconds.`);
      return;
    }
    mutation.mutate({
      id: actionId,
      params: { feature_id: featureId },
      data: { interval_seconds: intervalSeconds, enabled: true },
    });
  }

  function handleToggle(checked: boolean): void {
    if (checked) {
      commit(draft);
    } else {
      mutation.mutate({
        id: actionId,
        params: { feature_id: featureId },
        data: { interval_seconds: null, enabled: false },
      });
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-xs font-medium text-foreground">
          <Switch checked={enabled} onCheckedChange={handleToggle} disabled={isLoading} />
          Run periodically
        </label>
        {mutation.isPending && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      </div>

      {enabled ? (
        <ScheduleIntervalEditor draft={draft} setDraft={setDraft} commit={commit} />
      ) : (
        <p className="text-xs text-muted-foreground italic">
          Manual only. Toggle on to run on a recurring schedule.
        </p>
      )}
    </div>
  );
}

import { toast } from "sonner";
import { z } from "zod";
import { scopedToastDescription } from "@/components/ToastScope";
import type { GitStatusHealth } from "./useGitStatusStore";

export const statusHealthSchema = z.object({
  feature_id: z.number(),
  error: z.string().min(1).optional(),
  watcher_error: z.string().min(1).nullable().optional(),
});

const issues = [
  { field: "statusError", prefix: "git-status-error", title: "Git status error" },
  { field: "watcherError", prefix: "git-watcher-error", title: "Git live updates unavailable" },
] as const;

export function notifyGitStatusHealth(
  featureId: number,
  previous: GitStatusHealth | undefined,
  next: GitStatusHealth | undefined,
): void {
  for (const { field, prefix, title } of issues) {
    const error = next?.[field];
    if (error === previous?.[field]) continue;
    const id = `${prefix}-${featureId}`;
    if (error) {
      toast.error(title, { id, description: scopedToastDescription({ featureId }, error) });
    } else {
      toast.dismiss(id);
    }
  }
}

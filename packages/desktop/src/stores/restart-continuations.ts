import { toast } from "sonner";
import { z } from "zod";
import {
  RestartContinuationOutcome,
  type RestartContinuationEntry,
  type RestartContinuationReport,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";

/**
 * Tells the user which agents the last restart interrupted (an app update, a
 * reinstalled local build, a crash) and what Cadencr did about each one.
 *
 * The backend resumes the interrupted conversations at startup and publishes
 * one report per service process as `app/restart_continuations`. Every client
 * shows it once (keyed by the process's `boot_id`), including remote devices.
 */

const SHOWN_STORAGE_KEY = "cadencr.restart-continuations.shown-boot";
const TOAST_ID = "restart-continuations";
const NAMES_SHOWN = 3;

function buildReportSchema() {
  const entrySchema = z.object({
    session_id: z.number(),
    feature_id: z.number(),
    project_id: z.number(),
    feature_title: z.string(),
    outcome: z.enum(RestartContinuationOutcome),
    reason: z.string().nullish(),
  }) satisfies z.ZodType<RestartContinuationEntry>;
  return z.object({
    boot_id: z.string(),
    app_version: z.string(),
    previous_version: z.string().nullish(),
    entries: z.array(entrySchema),
    error: z.string().nullish(),
  }) satisfies z.ZodType<RestartContinuationReport>;
}

let reportSchema: ReturnType<typeof buildReportSchema> | null = null;

export interface RestartContinuationToast {
  tone: "success" | "warning";
  title: string;
  description: string;
  /** The one conversation the toast is about, when there is exactly one. */
  open: { projectId: number; featureId: number } | null;
}

/**
 * Skip codes that mean "nothing for the user to do" — not worth a mention.
 * `stopped_on_quit` is what they asked for when they quit; a `finished` turn
 * completed while Cadencr was shutting down.
 */
const SILENT_SKIPS = new Set(["archived", "already_running", "finished", "stopped_on_quit"]);

function names(entries: readonly RestartContinuationEntry[]): string {
  const titles = entries.map((entry) => entry.feature_title.trim() || "Untitled conversation");
  const shown = titles.slice(0, NAMES_SHOWN).join(", ");
  const rest = titles.length - NAMES_SHOWN;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

function agents(count: number): string {
  return count === 1 ? "1 agent" : `${count} agents`;
}

/** Word the report for a toast, or `null` when there is nothing to tell. */
export function describeRestartContinuations(
  report: RestartContinuationReport,
): RestartContinuationToast | null {
  const visible = report.entries.filter(
    (entry) => !(entry.outcome === "skipped" && SILENT_SKIPS.has(entry.reason ?? "")),
  );
  const resumed = visible.filter((entry) => entry.outcome === "resumed");
  const reasking = resumed.filter((entry) => entry.reason === "lost_gate");
  const disabled = visible.filter((entry) => entry.reason === "disabled");
  const looping = visible.filter((entry) => entry.reason === "loop_guard");
  const notResumed = visible.filter(
    (entry) => entry.outcome !== "resumed" && !disabled.includes(entry) && !looping.includes(entry),
  );
  if (visible.length === 0 && !report.error) return null;

  const lines: string[] = [];
  if (resumed.length > 0) {
    const verb = resumed.length === 1 ? "was" : "were";
    lines.push(`Resumed ${agents(resumed.length)} that ${verb} working: ${names(resumed)}.`);
  }
  if (reasking.length > 0) {
    const verb = reasking.length === 1 ? "was" : "were";
    lines.push(`${names(reasking)} ${verb} waiting on you and will ask again.`);
  }
  if (disabled.length > 0) {
    lines.push(
      `Automatic resume is off, so ${agents(disabled.length)} stayed stopped: ${names(disabled)}.`,
    );
  }
  if (looping.length > 0) {
    lines.push(
      `Not resumed again after several restarts in a row: ${names(looping)}. Open the conversation to continue.`,
    );
  }
  if (notResumed.length > 0) {
    lines.push(
      `Could not resume ${agents(notResumed.length)}: ${names(notResumed)}. Open the conversation to continue.`,
    );
  }
  if (report.error) lines.push(report.error);

  const single = visible.length === 1 ? visible[0] : null;
  return {
    tone: notResumed.length > 0 || looping.length > 0 || report.error ? "warning" : "success",
    title: report.previous_version
      ? `Cadencr updated to v${report.app_version}`
      : "Cadencr restarted",
    description: lines.join("\n"),
    open: single ? { projectId: single.project_id, featureId: single.feature_id } : null,
  };
}

function navigateTo(target: RestartContinuationToast["open"]): void {
  // Imported lazily: the router's route tree imports modules that load this one.
  import("@/router")
    .then(({ router }) =>
      target
        ? router.navigate({
            to: "/projects/$projectId/features/$featureId",
            params: { projectId: String(target.projectId), featureId: String(target.featureId) },
          })
        : router.navigate({ to: "/agents" }),
    )
    .catch((error: unknown) => {
      toast.error("Could not open the conversation", {
        description: apiErrorMessage(error, "Navigation failed"),
      });
    });
}

function showToast(content: RestartContinuationToast): void {
  const options = {
    id: TOAST_ID,
    description: content.description,
    // One line per outcome: a run-on paragraph is hard to scan in a narrow toast.
    classNames: { description: "whitespace-pre-line" },
    duration: 20_000,
    action: {
      label: content.open ? "Open" : "View agents",
      onClick: () => navigateTo(content.open),
    },
  };
  if (content.tone === "warning") toast.warning(content.title, options);
  else toast.success(content.title, options);
}

/** Handle `app/restart_continuations`: toast the report once per service process. */
export function applyRestartContinuationsEvent(payload: unknown): void {
  reportSchema ??= buildReportSchema();
  const parsed = reportSchema.safeParse(payload);
  if (!parsed.success) {
    toast.error("Could not read which agents the restart interrupted", {
      description: parsed.error.message,
    });
    return;
  }
  const report = parsed.data;
  if (localStorage.getItem(SHOWN_STORAGE_KEY) === report.boot_id) return;
  localStorage.setItem(SHOWN_STORAGE_KEY, report.boot_id);
  const content = describeRestartContinuations(report);
  if (content) showToast(content);
}

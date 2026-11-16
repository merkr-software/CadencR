import { toast } from "sonner";
import { RESET_TOAST_STAGE } from "@/lib/staged-toast";
import { z } from "zod";
import {
  getGetProviderUpdatesQueryKey,
  ProviderOrigin,
  ProviderUpdateActivity,
  ProviderUpdateState,
  updateProvider,
  type ProviderUpdateEvent,
  type ProviderUpdateOutcome,
  type ProviderUpdateStatus,
  type ProviderUpdatesResponse,
} from "@/api/generated";
import { apiErrorMessage } from "@/lib/api-errors";
import { parseJsonSetting } from "@/lib/json-setting";
import { queryClient } from "@/lib/queryClient";
import { PROVIDER_UPDATES_SETTINGS_ANCHOR } from "@/lib/settings-anchors";

/**
 * Provider version detection and updates, host-side.
 *
 * The backend checks every provider at launch and every few hours, then pushes
 * the full status list as `app/provider_updates`. This module mirrors that list
 * into the React Query cache (the settings card reads it from there), toasts
 * each newly detected version once, and reports update outcomes.
 */

const NOTIFIED_STORAGE_KEY = "cadencr.provider-updates.notified";
const notifiedSchema = z.record(z.string(), z.string());

/**
 * Built on first use: this module loads with the app-WebSocket handlers, and
 * reading the generated enums at import time would tie every module that
 * loads those handlers to the generated client's runtime values.
 */
function buildEventSchema() {
  const statusSchema = z.object({
    provider_id: z.string(),
    label: z.string(),
    origin: z.enum(ProviderOrigin),
    state: z.enum(ProviderUpdateState),
    activity: z.enum(ProviderUpdateActivity).nullish(),
    current_version: z.string().nullish(),
    latest_version: z.string().nullish(),
    available_versions: z.array(z.string()),
    supports_target_version: z.boolean(),
    error: z.string().nullish(),
  }) satisfies z.ZodType<ProviderUpdateStatus>;
  return z.object({
    providers: z.array(statusSchema),
    checked_at: z.string().nullish(),
    outcome: z
      .object({
        provider_id: z.string(),
        label: z.string(),
        success: z.boolean(),
        previous_version: z.string().nullish(),
        current_version: z.string().nullish(),
        message: z.string().nullish(),
      })
      .nullish(),
  }) satisfies z.ZodType<ProviderUpdateEvent>;
}

let eventSchema: ReturnType<typeof buildEventSchema> | null = null;

function toastId(providerId: string): string {
  return `provider-update-${providerId}`;
}

/**
 * Last version announced per provider, so a version toasts exactly once. A
 * corrupt cache only means versions may be announced again.
 */
function readNotifiedVersions(): Record<string, string> {
  const { value } = parseJsonSetting(
    localStorage.getItem(NOTIFIED_STORAGE_KEY),
    notifiedSchema,
    "a provider → version map",
  );
  return value ?? {};
}

/**
 * Providers whose "Updating…" loading toast is open. The outcome event closes
 * it; if that event was missed (socket reconnect mid-update), the next status
 * list without `updating` does.
 */
const openUpdateToasts = new Set<string>();

function openProviderSettings(): void {
  // Imported lazily: the router's route tree imports the settings page, which
  // imports this module.
  import("@/router")
    .then(async ({ router }) => {
      await router.navigate({
        to: "/settings",
        search: { section: PROVIDER_UPDATES_SETTINGS_ANCHOR },
      });
      // The settings page only scrolls when `section` changes, so a click while
      // already on this URL would otherwise leave the card off-screen.
      document.getElementById(PROVIDER_UPDATES_SETTINGS_ANCHOR)?.scrollIntoView({ block: "start" });
    })
    .catch((error: unknown) => {
      toast.error("Could not open provider settings", {
        description: apiErrorMessage(error, "Navigation failed"),
      });
    });
}

/** Toast every version detected since the last announcement. */
function notifyNewProviderVersions(providers: ProviderUpdateStatus[]): void {
  const notified = readNotifiedVersions();
  const fresh = providers.filter(
    (status) =>
      status.state === "update_available" &&
      status.activity !== "updating" &&
      status.latest_version &&
      notified[status.provider_id] !== status.latest_version,
  );
  if (fresh.length === 0) return;
  for (const status of fresh) notified[status.provider_id] = status.latest_version ?? "";
  localStorage.setItem(NOTIFIED_STORAGE_KEY, JSON.stringify(notified));

  if (fresh.length > 1) {
    toast("Provider updates available", {
      id: "provider-updates-available",
      description: fresh.map((status) => `${status.label} ${status.latest_version}`).join(" · "),
      duration: 15_000,
      action: { label: "Review", onClick: openProviderSettings },
    });
    return;
  }
  const [status] = fresh;
  toast(`${status.label} ${status.latest_version} is available`, {
    id: toastId(status.provider_id),
    description: status.current_version ? `You have ${status.current_version}.` : undefined,
    duration: 15_000,
    action: {
      label: "Update",
      onClick: (event) => {
        // Sonner closes a toast after its action unless the click is
        // prevented — and that close would remove the "Updating…" toast this
        // one turns into, since both share the id.
        event.preventDefault();
        void startProviderUpdate(status);
      },
    },
    cancel: { label: "Details", onClick: openProviderSettings },
  });
}

/** Start an update; its outcome arrives later as a WebSocket event. */
export async function startProviderUpdate(
  status: Pick<ProviderUpdateStatus, "provider_id" | "label">,
  version?: string,
): Promise<void> {
  const id = toastId(status.provider_id);
  toast.loading(`Updating ${status.label}…`, { ...RESET_TOAST_STAGE, id });
  openUpdateToasts.add(status.provider_id);
  try {
    await updateProvider(status.provider_id, version ? { version } : {});
  } catch (error) {
    openUpdateToasts.delete(status.provider_id);
    toast.error(`Could not update ${status.label}`, {
      ...RESET_TOAST_STAGE,
      id,
      description: apiErrorMessage(error, "The update request failed"),
    });
  }
}

function showOutcomeToast(outcome: ProviderUpdateOutcome): void {
  const id = toastId(outcome.provider_id);
  if (!outcome.success) {
    toast.error(`${outcome.label} update failed`, {
      ...RESET_TOAST_STAGE,
      id,
      description: outcome.message ?? "The provider's updater reported an error.",
      duration: 20_000,
      action: { label: "Details", onClick: openProviderSettings },
    });
    return;
  }
  const { previous_version: previous, current_version: current } = outcome;
  const changed = previous && current && previous !== current;
  toast.success(`${outcome.label} updated`, {
    ...RESET_TOAST_STAGE,
    id,
    description: changed
      ? `${previous} → ${current}. New sessions use it; running ones keep their version.`
      : (outcome.message ?? (current ? `Now on ${current}.` : undefined)),
  });
}

/** `app/provider_updates` envelope handler. */
export function applyProviderUpdatesEvent(payload: Record<string, unknown>): void {
  eventSchema ??= buildEventSchema();
  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success) {
    toast.error("Received an invalid provider update event.");
    return;
  }
  const event = parsed.data;
  queryClient.setQueryData(getGetProviderUpdatesQueryKey(), {
    providers: event.providers,
    checked_at: event.checked_at,
  } satisfies ProviderUpdatesResponse);
  if (event.outcome) {
    openUpdateToasts.delete(event.outcome.provider_id);
    showOutcomeToast(event.outcome);
  }
  closeStaleUpdateToasts(event.providers);
  notifyNewProviderVersions(event.providers);
}

function closeStaleUpdateToasts(providers: ProviderUpdateStatus[]): void {
  for (const status of providers) {
    if (openUpdateToasts.has(status.provider_id) && status.activity !== "updating") {
      openUpdateToasts.delete(status.provider_id);
      toast.dismiss(toastId(status.provider_id));
    }
  }
}

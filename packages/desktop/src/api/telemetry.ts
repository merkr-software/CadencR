import { z } from "zod";
import {
  getPreferences,
  putPreferences,
  resetIdentity,
  type TelemetryConsent,
  type TelemetryPreferences as ApiTelemetryState,
} from "./generated";

const status = z.enum(["disabled", "not_configured", "ready", "delivery_failed"]);
const telemetryStateSchema: z.ZodType<ApiTelemetryState> = z.object({
  diagnostics_enabled: z.boolean(),
  usage_enabled: z.boolean(),
  audience_enabled: z.boolean(),
  decision_version: z.number().int().nullable(),
  installation_id: z.string().nullable(),
  diagnostics_configured: z.boolean(),
  usage_configured: z.boolean(),
  audience_configured: z.boolean(),
  diagnostics_status: status,
  usage_status: status,
  audience_status: status,
});
export type TelemetryState = ApiTelemetryState;
export type TelemetryPreferences = Pick<
  TelemetryState,
  "diagnostics_enabled" | "usage_enabled" | "audience_enabled"
>;

export async function readTelemetry(): Promise<TelemetryState> {
  return telemetryStateSchema.parse(await getPreferences());
}
export async function updateTelemetry(data: TelemetryConsent): Promise<TelemetryState> {
  return telemetryStateSchema.parse(await putPreferences(data));
}
export async function resetTelemetryIdentity(): Promise<TelemetryState> {
  return telemetryStateSchema.parse(await resetIdentity());
}

export const TELEMETRY_QUERY_KEY = ["telemetry-preferences"] as const;
export const TELEMETRY_DECISION_VERSION = 1;

export function needsTelemetryDecision(state: TelemetryState): boolean {
  return (state.decision_version ?? 0) < TELEMETRY_DECISION_VERSION;
}

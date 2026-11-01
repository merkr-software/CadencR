import { Button } from "@/components/ui/button";
import { SettingsSubsection } from "./SettingsSubsection";

const identity = "00000000-0000-4000-8000-000000000000";
const examples = [
  {
    label: "PostHog usage event",
    payload: {
      event: "app_session_started",
      distinct_id: identity,
      timestamp: "2026-11-01T12:00:00Z",
      properties: {
        $process_person_profile: false,
        $geoip_disable: true,
        $ip: "0.0.0.0",
        release: "cadencr@0.15.1",
        os: "macos",
        process: "service",
        schema_version: 1,
        arch: "aarch64",
      },
    },
  },
  {
    label: "Sentry technical diagnostic",
    payload: {
      event_id: "00000000000040008000000000000000",
      timestamp: "2026-11-01T12:00:00Z",
      level: "error",
      platform: "javascript",
      release: "cadencr@0.15.1",
      dist: "build-id",
      user: { id: identity, ip_address: "0.0.0.0" },
      tags: { process: "renderer", os: "macos", arch: "aarch64", schema_version: "1" },
      fingerprint: ["{{ default }}", "react_boundary"],
      exception: {
        values: [
          {
            type: "react_boundary",
            value: "Cadencr diagnostic",
            stacktrace: {
              frames: [
                {
                  filename: "app:///assets/index-AbCd1234.js",
                  abs_path: "app:///assets/index-AbCd1234.js",
                  lineno: 12,
                  colno: 34,
                  in_app: true,
                },
              ],
            },
          },
        ],
      },
    },
  },
];

export function TelemetryDetails({
  disabled,
  onReset,
}: {
  disabled: boolean;
  onReset: () => void;
}): React.JSX.Element {
  return (
    <SettingsSubsection>
      <p className="text-xs leading-relaxed text-muted-foreground">
        No prompts, agent replies, code, terminal output, repository names, workspace file paths,
        log files or session replay are sent. Detailed Sentry and PostHog reports include app
        version, platform and a random installation ID, which links reports from this installation.
        Error messages and stack source text stay local. The separate approximate monthly audience
        counter sends one minimal PostHog event per month with a fresh ID; it does not use this
        detailed telemetry ID or link activity across months. PostHog receives the connection IP
        when an event is delivered, even though the payload suppresses IP storage and geolocation.
      </p>
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer font-medium">
          Example payloads (Sentry and PostHog)
        </summary>
        {examples.map(({ label, payload }) => (
          <div key={label} className="mt-3">
            <p className="font-medium">{label}</p>
            <pre className="mt-2 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">
              {JSON.stringify(payload, null, 2)}
            </pre>
          </div>
        ))}
        <p className="mt-2 text-muted-foreground">
          Illustrative IDs and app version. Configured routing keys are omitted.
        </p>
      </details>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button size="sm" variant="outline" disabled={disabled} onClick={onReset}>
          Reset telemetry ID
        </Button>
        <span className="text-xs text-muted-foreground">
          Creates a fresh ID without changing your choices.
        </span>
      </div>
    </SettingsSubsection>
  );
}

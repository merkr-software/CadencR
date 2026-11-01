import { readdirSync } from "node:fs";
import path from "node:path";
import { app } from "electron";
import { packagedRendererDir } from "./sidecar";
import { getRuntimeConfig } from "./runtime-config";
import type { RemoteDiagnostic } from "../../src/shared/telemetry-diagnostics";

let pending = false;
let lastAttempt = 0;
let status: "idle" | "unavailable" = "idle";
let assetsUnavailable = false;
let bundledAssets: ReadonlySet<string> | null = null;

export function telemetryRelayStatus(): "idle" | "unavailable" | "frames_unavailable" {
  return status === "unavailable" ? status : assetsUnavailable ? "frames_unavailable" : "idle";
}

export function rendererTelemetryAssets(): ReadonlySet<string> {
  if (bundledAssets) return bundledAssets;
  try {
    const root = app.isPackaged
      ? path.join(packagedRendererDir(), "assets")
      : path.join(app.getAppPath(), "out", "renderer", "assets");
    bundledAssets = new Set(readdirSync(root).filter((name) => /^[A-Za-z0-9_-]+\.js$/.test(name)));
  } catch {
    // Dev assets are unbundled. Omit frames and expose the relay state in Settings.
    bundledAssets = new Set();
    assetsUnavailable = true;
  }
  return bundledAssets;
}

/** No queue, retry or cached consent: the service authorizes each event at delivery time. */
export function relayRemoteDiagnostic(event: RemoteDiagnostic): void {
  if (pending || Date.now() - lastAttempt < 1000) return;
  const config = getRuntimeConfig();
  if (!config.authToken) {
    status = "unavailable";
    return;
  }
  pending = true;
  lastAttempt = Date.now();
  void fetch(`${config.baseUrl}/api/telemetry/diagnostics`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cadencr-token": config.authToken },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(2000),
    redirect: "error",
  })
    .then((response) => {
      status = response.ok ? "idle" : "unavailable";
    })
    .catch(() => {
      // Settings exposes this failure; remote delivery must never break local crash capture.
      status = "unavailable";
    })
    .finally(() => {
      pending = false;
    });
}

import { z } from "zod";

export interface RuntimeConfig {
  baseUrl: string;
  authToken: string | null;
}

let runtimeConfig: RuntimeConfig = {
  baseUrl: "http://127.0.0.1:5005",
  authToken: null,
};

export function setRuntimeConfig(nextConfig: RuntimeConfig): void {
  runtimeConfig = nextConfig;
  browserOriginPolicyReady = false;
}

export function getRuntimeConfig(): RuntimeConfig {
  return runtimeConfig;
}

/** Public projection: the sidecar bearer must never cross the preload boundary. */
export function getRendererRuntimeConfig(): { baseUrl: string } {
  return { baseUrl: runtimeConfig.baseUrl };
}

let browserRemoteOrigins: readonly string[] = [];
let browserOriginPolicyReady = false;
let browserOriginRefresh: Promise<void> | null = null;

export function isBrowserOriginPolicyReady(): boolean {
  return browserOriginPolicyReady;
}

export function setBrowserOriginPolicyReady(ready: boolean): void {
  browserOriginPolicyReady = ready;
}

export function setBrowserRemoteOrigins(origins: readonly string[]): void {
  browserRemoteOrigins = origins;
  browserOriginPolicyReady = true;
}

/** Used by Browser guest navigation guards, including aliases at protected ports. */
export function getBrowserDeniedOrigins(): readonly string[] {
  const frontendPort = process.env.VITE_FRONTEND_PORT || "1420";
  const remotePort = process.env.CADENCR_REMOTE_PORT || "5006";
  return [
    runtimeConfig.baseUrl,
    process.env.ELECTRON_RENDERER_URL || `http://127.0.0.1:${frontendPort}`,
    `https://127.0.0.1:${remotePort}`,
    ...browserRemoteOrigins,
  ];
}

const remoteOriginStatus = z.object({
  enabled: z.boolean(),
  port: z.number().int().min(1).max(65535).nullable(),
  lan_urls: z.array(z.string().url()),
  tunnel_host: z.string().nullable(),
});

/** Refresh before Browser actions: remote listeners can change at runtime. */
export function refreshBrowserOriginPolicy(): Promise<void> {
  if (browserOriginRefresh) return browserOriginRefresh;
  browserOriginRefresh = loadBrowserOriginPolicy().finally(() => {
    browserOriginRefresh = null;
  });
  return browserOriginRefresh;
}

async function loadBrowserOriginPolicy(): Promise<void> {
  try {
    if (!runtimeConfig.authToken) throw new Error("Service credential is unavailable.");
    const response = await fetch(`${runtimeConfig.baseUrl}/api/remote/browser-origins`, {
      headers: { "x-cadencr-token": runtimeConfig.authToken },
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Remote origin metadata returned HTTP ${response.status}.`);
    const status = remoteOriginStatus.parse(await response.json());
    if (status.enabled && status.port === null) throw new Error("Remote listener port is unknown.");
    setBrowserRemoteOrigins([
      ...status.lan_urls,
      ...(status.port ? [`https://127.0.0.1:${status.port}`] : []),
      ...(status.tunnel_host ? [`https://${status.tunnel_host}`] : []),
    ]);
  } catch (error) {
    browserOriginPolicyReady = false;
    throw new Error(
      "Browser access is unavailable because Cadencr listener origins could not be verified.",
      { cause: error },
    );
  }
}

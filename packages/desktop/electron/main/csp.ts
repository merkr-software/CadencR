export interface RendererCspDevelopmentEndpoints {
  apiUrl: string;
  rendererUrl: string;
}

interface RendererCspDevelopmentEnvironment {
  ELECTRON_RENDERER_URL?: string;
  VITE_API_URL?: string;
  VITE_FRONTEND_PORT?: string;
}

interface ResolvedRendererCspDevelopment extends RendererCspDevelopmentEndpoints {
  frontendPort: number;
}

const DEFAULT_DEVELOPMENT_API_URL = "http://127.0.0.1:5005";
const DEFAULT_DEVELOPMENT_FRONTEND_PORT = 1420;
const SIDECAR_URL = "http://127.0.0.1:5004";

export function resolveRendererCspDevelopment(
  environment: RendererCspDevelopmentEnvironment,
): ResolvedRendererCspDevelopment {
  const parsedFrontendPort = Number(environment.VITE_FRONTEND_PORT);
  const frontendPort =
    Number.isInteger(parsedFrontendPort) && parsedFrontendPort > 0 && parsedFrontendPort <= 65535
      ? parsedFrontendPort
      : DEFAULT_DEVELOPMENT_FRONTEND_PORT;
  return {
    apiUrl: environment.VITE_API_URL ?? DEFAULT_DEVELOPMENT_API_URL,
    rendererUrl: environment.ELECTRON_RENDERER_URL ?? `http://127.0.0.1:${frontendPort}`,
    frontendPort,
  };
}

function connectSources(rawUrl: string): string[] {
  const httpUrl = new URL(rawUrl);
  if (httpUrl.protocol !== "http:" && httpUrl.protocol !== "https:") {
    throw new Error(`CSP connect URL must use http:// or https://: ${rawUrl}`);
  }
  const websocketUrl = new URL(httpUrl.origin);
  websocketUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
  return [httpUrl.origin, websocketUrl.origin];
}

export function rendererCsp(
  isPackaged: boolean,
  developmentEndpoints: RendererCspDevelopmentEndpoints = resolveRendererCspDevelopment({}),
): string {
  const scriptSrc = isPackaged
    ? "script-src 'self' 'wasm-unsafe-eval'"
    : "script-src 'self' 'unsafe-eval' 'unsafe-inline' 'wasm-unsafe-eval'";
  const connectUrls = connectSources(SIDECAR_URL);
  if (!isPackaged) {
    connectUrls.push(
      ...connectSources(developmentEndpoints.apiUrl),
      ...connectSources(developmentEndpoints.rendererUrl),
    );
  }
  const connectSrc = `connect-src 'self' data: ${[...new Set(connectUrls)].join(" ")}`;
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    connectSrc,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; ");
}

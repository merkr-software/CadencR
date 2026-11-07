import { SIDECAR_BASE_URL } from "./sidecar-port";

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
  const connectUrls = connectSources(SIDECAR_BASE_URL);
  if (!isPackaged) {
    connectUrls.push(
      ...connectSources(developmentEndpoints.apiUrl),
      ...connectSources(developmentEndpoints.rendererUrl),
    );
  }
  const connectSrc = `connect-src 'self' data: ${[...new Set(connectUrls)].join(" ")}`;
  // The service's sandboxed visual shell (`/visual-frame`) is the only frame
  // the renderer embeds; its own CSP sandboxes whatever it renders, and this
  // directive also refuses any navigation of the frame to another origin.
  const frameUrls = connectUrls.filter((url) => url.startsWith("http"));
  const frameSrc = `frame-src ${[...new Set(frameUrls)].join(" ")}`;
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    // The Office preview's parser workers are inline module scripts started
    // from `blob:` URLs the library mints itself; `script-src` stays strict.
    "worker-src 'self' blob:",
    connectSrc,
    frameSrc,
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** Vite must send this as a response header: frame-ancestors is ignored in HTML meta tags. */
export function rendererDevelopmentHeaders(
  developmentEndpoints: RendererCspDevelopmentEndpoints,
): Record<string, string> {
  return {
    "Content-Security-Policy": rendererCsp(false, developmentEndpoints),
    "X-Frame-Options": "DENY",
  };
}

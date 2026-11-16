import type { IncomingMessage } from "node:http";
import type { Plugin, ProxyOptions } from "vite";

import { VISUAL_FRAME_PATH } from "../src/shared/visual-frame";

export function isDevServiceRequest(
  headers: IncomingMessage["headers"],
  rendererOrigin: string,
): boolean {
  if (headers.host !== new URL(rendererOrigin).host) return false;
  if (headers.origin !== undefined) return headers.origin === rendererOrigin;
  // Same-origin GETs omit Origin. Require the browser's non-forgeable site
  // classification plus an exact-origin Referer; never authorize an absent pair.
  if (headers["sec-fetch-site"] !== "same-origin" || !headers.referer) return false;
  try {
    const referer = new URL(headers.referer);
    return !referer.username && !referer.password && referer.origin === rendererOrigin;
  } catch {
    return false;
  }
}

/** Server-only credentialed proxy, accessible only from the configured development app. */
export function devServiceProxy(
  rendererOrigin: string,
  serviceOrigin: string,
  token: string,
): { plugin: Plugin; proxy: Record<string, ProxyOptions> } {
  const proxy: ProxyOptions = {
    target: serviceOrigin,
    changeOrigin: true,
    ws: true,
    // A service redirect is returned to the browser. Never follow it with the bearer.
    followRedirects: false,
    configure(server) {
      server.on("proxyReq", (outgoing, incoming) => {
        outgoing.removeHeader("x-cadencr-token");
        if (!isDevServiceRequest(incoming.headers, rendererOrigin) || !token) {
          outgoing.destroy(new Error("Rejected development service proxy request."));
          return;
        }
        if (!incoming.headers["x-cadencr-plugin-token"])
          outgoing.setHeader("x-cadencr-token", token);
      });
      server.on("proxyReqWs", (outgoing, incoming, socket) => {
        outgoing.removeHeader("x-cadencr-token");
        if (!isDevServiceRequest(incoming.headers, rendererOrigin) || !token) {
          socket.destroy();
          outgoing.destroy();
          return;
        }
        outgoing.setHeader("x-cadencr-token", token);
      });
      server.on("proxyRes", (response, incoming) => {
        if (isDevServiceRequest(incoming.headers, rendererOrigin)) {
          response.headers["access-control-allow-origin"] = rendererOrigin;
        }
      });
    },
  };
  return {
    proxy: {
      "/api": proxy,
      "/ws": proxy,
      "/health": proxy,
      // The visual sandbox shell is public and carries no credential: a plain
      // pass-through, so a browser renderer frames it from its own origin.
      [VISUAL_FRAME_PATH]: { target: serviceOrigin, changeOrigin: true, followRedirects: false },
    },
    plugin: {
      name: "cadencr-dev-service-proxy",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (!/^\/(?:api(?:\/|$)|ws(?:[/?]|$)|health(?:[/?]|$))/.test(request.url || "")) {
            next();
            return;
          }
          if (!isDevServiceRequest(request.headers, rendererOrigin)) {
            response.writeHead(403).end("Forbidden");
            return;
          }
          // Handle preflight locally; the bearer never reaches OPTIONS responses.
          if (request.method === "OPTIONS") {
            response
              .writeHead(204, {
                "Access-Control-Allow-Origin": rendererOrigin,
                "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, X-Cadencr-Plugin-Token",
              })
              .end();
            return;
          }
          next();
        });
      },
    },
  };
}

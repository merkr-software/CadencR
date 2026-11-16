// MSW server for vitest. A single catch-all handler intercepts every HTTP
// request fired by tests so unmocked React Query hooks resolve instead of
// throwing `AxiosError: Network Error`. Tests that need a specific response
// shape continue to mock at the hook layer (`vi.mock("@/api/generated", ...)`);
// hook-level mocks short-circuit before the request, so MSW only catches the
// long tail of unmocked hooks.

import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { developmentApiBaseUrl } from "@/api/runtime-origin";

// Follow the same narrow origin selection as the runtime client: plain HTTP
// browsers use Vite's same-origin credentialed proxy, while Node and Electron
// use the configured sidecar endpoint. Keep this helper independent of Axios
// so installing MSW does not initialize or cache the API client before mocks.
export const API_BASE_URL = developmentApiBaseUrl();

export const server = setupServer(
  http.all(`${API_BASE_URL}/*`, () => HttpResponse.json({}, { status: 200 })),
);

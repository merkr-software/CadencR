import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDesktopBridgeOverrideForTests,
  setDesktopBridgeOverrideForTests,
} from "@/lib/desktop-bridge";
import type { CliRendererItem } from "@/shared/cli-bridge";
import { useCliFileOpenStore } from "@/stores/cli-file-open-store";
import { API_BASE_URL, server } from "@/test/msw-server";
import { CliRequestBridge } from "./CliRequestBridge";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(() => "toast-id"),
  },
  checkForUpdates: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/lib/cli/follow-update-check", () => ({ followUpdateCheck: mocks.checkForUpdates }));

function bridgeWith(batches: CliRendererItem[][]) {
  let ping: (() => void) | null = null;
  const drainCliRequests = vi.fn(() => Promise.resolve(batches.shift() ?? []));
  setDesktopBridgeOverrideForTests({
    drainCliRequests,
    onCliRequestsPending: (cb) => {
      ping = cb;
      return () => {
        ping = null;
      };
    },
  });
  return { drainCliRequests, ping: () => ping?.() };
}

function renderBridge() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CliRequestBridge />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useCliFileOpenStore.setState({ pending: null });
  server.use(
    http.get(`${API_BASE_URL}/api/projects`, () =>
      HttpResponse.json([
        { id: 4, name: "app", path: "/work/app", created_at: "2026-11-01T00:00:00Z" },
      ]),
    ),
    http.get(`${API_BASE_URL}/api/git/feature-worktrees`, () => HttpResponse.json([])),
    http.get(`${API_BASE_URL}/api/features`, () =>
      HttpResponse.json([
        {
          id: 9,
          project_id: 4,
          title: "Session 1",
          type: "ws-session",
          status: "active",
          is_pinned: false,
          created_at: "2026-11-01T00:00:00Z",
          last_activity_at: "2026-11-10T00:00:00Z",
        },
      ]),
    ),
  );
});
afterEach(() => clearDesktopBridgeOverrideForTests());

describe("CliRequestBridge", () => {
  it("drains on mount and on every ping, surfacing errors and update checks", async () => {
    const bridge = bridgeWith([
      [{ id: "a", kind: "error", message: "bad request" }],
      [{ id: "b", kind: "update" }],
    ]);
    renderBridge();
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith("bad request"));
    bridge.ping();
    await waitFor(() => expect(mocks.checkForUpdates).toHaveBeenCalledOnce());
    expect(bridge.drainCliRequests).toHaveBeenCalledTimes(2);
  });

  it("opens a project that is already added instead of adding it twice", async () => {
    bridgeWith([[{ id: "a", kind: "add", path: "/work/app/" }]]);
    renderBridge();
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({ to: "/", search: { projectId: 4 } }),
    );
    expect(mocks.toast.info).toHaveBeenCalledWith("app is already a project");
    expect(mocks.toast.loading).not.toHaveBeenCalled();
  });

  it("opens a file in the conversation working in the checkout", async () => {
    bridgeWith([
      [{ id: "a", kind: "open", path: "/work/app/src/main.rs", pathKind: "file", line: 7 }],
    ]);
    renderBridge();
    await waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: "/projects/$projectId/features/$featureId",
        params: { projectId: "4", featureId: "9" },
      }),
    );
    expect(useCliFileOpenStore.getState().pending).toEqual({
      featureId: 9,
      relativePath: "src/main.rs",
      line: 7,
      at: expect.any(Number),
    });
  });

  it("points a path outside every project at cadencr add", async () => {
    bridgeWith([[{ id: "a", kind: "open", path: "/tmp/elsewhere", pathKind: "directory" }]]);
    renderBridge();
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(
        "/tmp/elsewhere is not in a Cadencr project.",
        {
          description: "Add its folder first: cadencr add <folder>",
        },
      ),
    );
  });
});

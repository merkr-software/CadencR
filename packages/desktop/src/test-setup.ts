// Shared test setup — runs for every test file, in both the `node` and `dom`
// vitest projects (see `vitest.config.ts`). Anything that needs `window` or
// `document` belongs in `./test-setup-dom.ts`, which is only loaded when the
// file runs in a DOM environment.
import { vi, afterEach, afterAll, beforeAll, beforeEach } from "vitest";
import { server } from "./test/msw-server";
import { setDeltaFlushScheduler } from "./stores/ws-delta-scheduler";

// ---------------------------------------------------------------------------
// Stream-delta coalescing — apply synchronously in tests
// ---------------------------------------------------------------------------
//
// Production coalesces `session.message` deltas per animation frame (see
// `ws-delta-coalescer.ts`). The store's existing tests fire a message envelope
// and assert on the resulting blocks synchronously, so default the scheduler to
// an immediate flush. Tests that specifically exercise batching install their
// own manual scheduler inside the test body.
beforeEach(() => {
  setDeltaFlushScheduler((flush) => flush());
});

// ---------------------------------------------------------------------------
// MSW — intercept HTTP so unmocked React Query hooks resolve cleanly
// ---------------------------------------------------------------------------
//
// Many component tests mount real components whose React Query hooks fire
// axios requests against `http://127.0.0.1:5005`. There is no backend in
// tests, so without MSW every unmocked hook would emit a full `AxiosError:
// Network Error` stack via React Query's default `onError` — dozens of lines
// per test. MSW's catch-all handler (see `./test/msw-server.ts`) returns an
// empty JSON body for any request, so hooks resolve to an empty payload and
// stay silent. Tests that need a real response shape mock at the hook layer
// (`vi.mock("@/api/generated", …)`), which short-circuits before the request
// reaches MSW.
//
// `onUnhandledRequest: "bypass"` keeps non-API fetches (asset URLs, etc.)
// silent — unmatched requests just fall through to the (absent) network.
beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
  // MSW's interceptor installs `globalThis.WebSocket` as a non-writable
  // property. WebSocket-focused tests (`ws-connection.test.ts`,
  // `useTerminalWebSocket.test.ts`) swap `globalThis.WebSocket` for a
  // `MockWebSocket` class and would otherwise throw on assignment. Flip the
  // descriptor to writable; the value is left untouched.
  Object.defineProperty(globalThis, "WebSocket", {
    writable: true,
    configurable: true,
  });
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// ---------------------------------------------------------------------------
// navigator.platform — pretend tests run on macOS
// ---------------------------------------------------------------------------
//
// Neither the test DOMs nor Node report a macOS `navigator.platform` on every
// host. Shortcut display and TanStack's `Mod` resolver use it to decide
// whether the primary modifier is Command (macOS) or Control (Windows/Linux). Forcing the
// platform to mac here keeps tests aligned with the desktop default (and
// identical on Linux CI); cross-platform resolver and matcher coverage lives in
// the shortcut unit tests.
Object.defineProperty(navigator, "platform", {
  configurable: true,
  value: "MacIntel",
});

// ---------------------------------------------------------------------------
// react-virtuoso
// ---------------------------------------------------------------------------
// Virtuoso relies on real layout (ResizeObserver size + viewport math) which
// jsdom doesn't provide, so it renders zero rows out of the box. We replace
// it with a flat render of every item so tests can `findByText` content
// inside virtualized lists. Tests that need to drive Virtuoso-specific
// callbacks (atBottomStateChange, startReached, etc.) can still call
// `vi.mock("react-virtuoso", ...)` locally — the local mock wins.
vi.mock("react-virtuoso", () => import("./test/react-virtuoso-mock"));

// ---------------------------------------------------------------------------
// DOM-only setup (jest-dom, Testing Library cleanup, layout API stubs)
// ---------------------------------------------------------------------------
if (typeof window !== "undefined") {
  await import("./test-setup-dom");
}

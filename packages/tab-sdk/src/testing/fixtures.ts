import type { TabContext, ThemeSnapshot, WireHttpResponse } from "../protocol.js";

export const DEFAULT_TEST_CONTEXT: TabContext = {
  project: { id: 1, name: "Demo project", path: "/tmp/demo-project" },
  feature: {
    id: 10,
    name: "Demo feature",
    branch: "feature/demo",
    baseBranch: "main",
    worktreePath: "/tmp/demo-project",
  },
  pullRequest: null,
  session: null,
};

/** CadencR Dark's core palette. */
export const DEFAULT_TEST_THEME: ThemeSnapshot = {
  id: "cadencr-dark",
  appearance: "dark",
  tokens: {
    background: "#131416",
    foreground: "#eff0f2",
    card: "#1a1b1d",
    "card-foreground": "#eff0f2",
    popover: "#1a1b1d",
    "popover-foreground": "#eff0f2",
    primary: "#2db47d",
    "primary-foreground": "#131416",
    secondary: "#1a1b1d",
    "secondary-foreground": "#eff0f2",
    muted: "#1a1b1d",
    "muted-foreground": "#a7a9ad",
    accent: "#202124",
    "accent-foreground": "#eff0f2",
    destructive: "#ec707b",
    border: "#34373a",
    input: "#202124",
    ring: "#2db47d",
  },
};

export function createTabContext(overrides: Partial<TabContext> = {}): TabContext {
  return { ...DEFAULT_TEST_CONTEXT, ...overrides };
}

export function createThemeSnapshot(overrides: Partial<ThemeSnapshot> = {}): ThemeSnapshot {
  return { ...DEFAULT_TEST_THEME, ...overrides };
}

/** A wire HTTP response with a JSON body (`api.request` / `net.fetch`). */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): WireHttpResponse {
  const bytes = new TextEncoder().encode(body === undefined ? "" : JSON.stringify(body));
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body: bytes.buffer as ArrayBuffer,
  };
}

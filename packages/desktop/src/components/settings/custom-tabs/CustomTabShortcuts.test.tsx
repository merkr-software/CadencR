import { describe, expect, it } from "vitest";

import { render, screen } from "@/test-utils";

import { CustomTabShortcuts } from "./CustomTabShortcuts";

describe("CustomTabShortcuts", () => {
  it("lists each shortcut, and says which Cadencr shortcut takes a colliding one", () => {
    render(
      <CustomTabShortcuts
        tab={{
          shortcuts: [
            { id: "palette", keys: ["mod", "k"], description: "Open the tab's palette" },
            { id: "refresh", keys: ["mod", "alt", "shift", "r"], description: "Refresh" },
          ],
        }}
      />,
    );
    expect(screen.getByText("Open the tab's palette")).toBeInTheDocument();
    expect(screen.getByText("Refresh")).toBeInTheDocument();
    expect(
      screen.getByText("Not available: Cadencr uses these keys for “Open command palette”."),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/^Not available/)).toHaveLength(1);
  });
});

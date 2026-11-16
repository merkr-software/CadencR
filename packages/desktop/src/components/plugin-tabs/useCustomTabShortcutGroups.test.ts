import { describe, expect, it } from "vitest";

import { pluginTabSummary } from "./plugin-tab-fixtures";
import { customTabShortcutGroups } from "./useCustomTabShortcutGroups";

const shortcuts = [
  { id: "palette", keys: ["mod", "k"], description: "Taken by the command palette" },
  { id: "refresh", keys: ["mod", "alt", "shift", "r"], description: "Refresh the graph" },
];

describe("customTabShortcutGroups", () => {
  it("lists the shortcuts that can fire, one group per tab the project can open", () => {
    const groups = customTabShortcutGroups(
      [
        pluginTabSummary({ shortcuts }),
        pluginTabSummary({
          id: "off",
          shortcuts,
          enablement: { global: false, project: null, effective: false, consent_required: false },
        }),
        pluginTabSummary({ id: "unbuilt", shortcuts, entry_present: false }),
        pluginTabSummary({ id: "none" }),
      ],
      {},
      true,
    );
    expect(groups).toEqual([
      {
        id: "plugin:graph",
        label: "Changed files graph",
        hint: "When the Graph tab has focus.",
        items: [
          {
            id: "plugin:graph:refresh",
            description: "Refresh the graph",
            keys: ["mod", "alt", "shift", "r"],
          },
        ],
      },
    ]);
  });
});

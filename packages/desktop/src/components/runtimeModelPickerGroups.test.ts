import { describe, expect, it } from "vitest";
import {
  browseGroupValue,
  catalogNeedsCollapse,
  displayModelDescription,
  displayModelId,
  displayModelLabel,
  getCatalogRefreshNotices,
  getModelEntries,
  groupCatalogEntries,
  IDLE_COLLAPSE_AFTER,
  initialExpandedGroupIds,
  isProviderCollapsed,
  isVendorCollapsed,
  modelPickerFilter,
  pickerProviderFromCatalog,
  vendorPrefix,
} from "./runtimeModelPickerGroups";
import type { RuntimeModelPickerProvider } from "./RuntimeModelPicker.types";

function provider(
  id: string,
  label: string,
  models: Array<{ id: string; label: string }>,
): RuntimeModelPickerProvider {
  return { id, label, disabled: false, models };
}

describe("runtimeModelPickerGroups", () => {
  it("groups rest entries by provider, with vendor prefixes as nested sections", () => {
    const entries = getModelEntries([
      provider("claude_code", "Claude", [{ id: "opus", label: "Opus" }]),
      provider("opencode", "OpenCode", [
        { id: "anthropic/claude-sonnet-4-6", label: "anthropic/claude-sonnet-4-6" },
        { id: "openai/gpt-5.4", label: "GPT-5.4" },
      ]),
    ]);

    const groups = groupCatalogEntries(entries, new Set());

    expect(groups.map((group) => ({ id: group.id, heading: group.heading }))).toEqual([
      { id: "claude_code", heading: "Claude" },
      { id: "opencode", heading: "OpenCode" },
    ]);
    expect(groups[1]?.vendors.map((vendor) => vendor.heading)).toEqual(["anthropic", "openai"]);
  });

  it("keeps starred models in their own non-collapsible group", () => {
    const entries = getModelEntries([
      provider("claude_code", "Claude", [
        { id: "opus", label: "Opus" },
        { id: "sonnet", label: "Sonnet" },
      ]),
    ]);

    const groups = groupCatalogEntries(entries, new Set(["claude_code:opus"]));

    expect(groups[0]).toMatchObject({
      id: "starred",
      heading: "Starred",
      kind: "starred",
      collapsible: false,
    });
    expect(groups[0]?.entries.map((entry) => entry.value)).toEqual(["claude_code:opus"]);
    expect(groups[1]?.entries.map((entry) => entry.value)).toEqual(["claude_code:sonnet"]);
  });

  it("strips a vendor prefix from ids that are used as labels, and still surfaces the full id", () => {
    const entry = getModelEntries([
      provider("opencode", "OpenCode", [
        { id: "anthropic/claude-sonnet-4-6", label: "anthropic/claude-sonnet-4-6" },
      ]),
    ])[0];
    expect(entry).toBeDefined();
    if (!entry) return;

    const visible = displayModelLabel(entry, "anthropic");
    expect(visible).toBe("claude-sonnet-4-6");
    expect(displayModelId(entry, visible)).toBe("anthropic/claude-sonnet-4-6");
    expect(vendorPrefix(entry.modelId)).toBe("anthropic");
  });

  it("does not restack a distinct catalog label with the raw id", () => {
    const entry = getModelEntries([
      provider("cursor", "Cursor", [{ id: "gpt-5.3-codex-fast", label: "Codex 5.3 Fast" }]),
    ])[0];
    expect(entry).toBeDefined();
    if (!entry) return;

    const visible = displayModelLabel(entry);
    expect(visible).toBe("Codex 5.3 Fast");
    expect(displayModelId(entry, visible)).toBeUndefined();
  });

  it("surfaces a catalog description when it adds information", () => {
    const entry = getModelEntries([
      {
        id: "claude_code",
        label: "Claude",
        disabled: false,
        models: [{ id: "opus", label: "Opus", description: "Frontier model for complex coding" }],
      },
    ])[0];
    expect(entry).toBeDefined();
    if (!entry) return;

    expect(displayModelDescription(entry, "Opus")).toBe("Frontier model for complex coding");
    expect(displayModelDescription({ ...entry, description: "Opus" }, "Opus")).toBeUndefined();
  });

  it("collapses idle catalogs only once they exceed the threshold", () => {
    const small = groupCatalogEntries(
      getModelEntries([
        provider(
          "claude_code",
          "Claude",
          Array.from({ length: IDLE_COLLAPSE_AFTER }, (_, index) => ({
            id: `m-${index}`,
            label: `M ${index}`,
          })),
        ),
      ]),
      new Set(),
    );
    const large = groupCatalogEntries(
      getModelEntries([
        provider(
          "claude_code",
          "Claude",
          Array.from({ length: IDLE_COLLAPSE_AFTER + 1 }, (_, index) => ({
            id: `m-${index}`,
            label: `M ${index}`,
          })),
        ),
      ]),
      new Set(),
    );

    expect(catalogNeedsCollapse(small)).toBe(false);
    expect(catalogNeedsCollapse(large)).toBe(true);
  });

  it("expands the provider that owns the current selection, even when that model is starred", () => {
    const entries = getModelEntries([
      provider("opencode", "OpenCode", [
        { id: "anthropic/claude-sonnet-4-6", label: "Sonnet" },
        { id: "anthropic/claude-opus-4-6", label: "Opus" },
        { id: "openai/gpt-5.4", label: "GPT-5.4" },
      ]),
    ]);
    const groups = groupCatalogEntries(entries, new Set(["opencode:anthropic/claude-sonnet-4-6"]));

    expect(initialExpandedGroupIds(groups, "opencode:anthropic/claude-sonnet-4-6")).toEqual([
      "opencode",
    ]);
    expect(initialExpandedGroupIds(groups, "opencode:openai/gpt-5.4")).toEqual(["opencode"]);
  });

  it("also expands a large vendor section that owns the current selection", () => {
    const entries = getModelEntries([
      provider("opencode", "OpenCode", [
        ...Array.from({ length: IDLE_COLLAPSE_AFTER + 1 }, (_, index) => ({
          id: `anthropic/model-${index}`,
          label: `Anthropic ${index}`,
        })),
        ...Array.from({ length: IDLE_COLLAPSE_AFTER + 1 }, (_, index) => ({
          id: `openai/gpt-${index}`,
          label: `GPT ${index}`,
        })),
      ]),
    ]);
    const groups = groupCatalogEntries(entries, new Set());

    expect(initialExpandedGroupIds(groups, "opencode:openai/gpt-0")).toEqual([
      "opencode",
      "opencode::openai",
    ]);
  });

  it("collapses sibling vendor sections that exceed the idle threshold", () => {
    const entries = getModelEntries([
      provider("opencode", "OpenCode", [
        { id: "anthropic/sonnet", label: "Sonnet" },
        ...Array.from({ length: IDLE_COLLAPSE_AFTER + 1 }, (_, index) => ({
          id: `openai/gpt-${index}`,
          label: `GPT ${index}`,
        })),
      ]),
    ]);
    const groups = groupCatalogEntries(entries, new Set());
    const group = groups[0];
    expect(group).toBeDefined();
    if (!group) return;

    const expanded = new Set(["opencode"]);
    const openai = group.vendors.find((vendor) => vendor.vendorKey === "openai");
    const anthropic = group.vendors.find((vendor) => vendor.vendorKey === "anthropic");
    expect(openai).toBeDefined();
    expect(anthropic).toBeDefined();
    if (!openai || !anthropic) return;

    expect(isProviderCollapsed(group, expanded, true, false)).toBe(false);
    expect(isVendorCollapsed(group, openai, expanded, true, false)).toBe(true);
    expect(isVendorCollapsed(group, anthropic, expanded, true, false)).toBe(false);
  });

  it("namespaces browse-row values away from model keys", () => {
    expect(browseGroupValue("opencode::anthropic")).toBe("__browse__:opencode::anthropic");
    expect(browseGroupValue("opencode::anthropic")).not.toBe(
      "opencode:anthropic/claude-sonnet-4-6",
    );
  });

  it("matches contiguous name or id substrings, not letter-subsequence fuzz", () => {
    const solKeywords = [
      "Codex CLI",
      "codex_cli",
      "GPT-5.6-Sol",
      "gpt-5.6-sol",
      "Most capable GPT-5.6 model",
    ];
    const fableKeywords = [
      "Codex CLI",
      "codex_cli",
      "GPT-5.6-Fable",
      "gpt-5.6-fable",
      "Most capable GPT-5.6 model",
    ];

    expect(modelPickerFilter("codex_cli:gpt-5.6-sol", "Sol", solKeywords)).toBeGreaterThan(0);
    expect(modelPickerFilter("codex_cli:gpt-5.6-fable", "Sol", fableKeywords)).toBe(0);
    expect(
      modelPickerFilter("claude_code:opus", "Claude", ["Claude", "claude_code", "Opus", "opus"]),
    ).toBeGreaterThan(0);
  });

  it("carries a catalog's refresh error into its picker provider", () => {
    const entry = pickerProviderFromCatalog({
      id: "codex_cli",
      label: "Codex CLI",
      models: [{ id: "gpt", label: "GPT" }],
      refresh_error: "Codex model/list timed out",
    });
    expect(entry).toEqual({
      id: "codex_cli",
      label: "Codex CLI",
      disabled: false,
      refreshError: "Codex model/list timed out",
      models: [{ id: "gpt", label: "GPT" }],
    });
  });

  it("notices only selectable providers serving their last known models", () => {
    const fresh = provider("claude_code", "Claude", [{ id: "opus", label: "Opus" }]);
    const lastKnown = {
      ...provider("opencode", "OpenCode", [{ id: "openai/gpt", label: "GPT" }]),
      refreshError: "unterminated opencode models JSON block",
    };
    const empty = { ...provider("codex_cli", "Codex CLI", []), refreshError: "boom" };
    const disabled = { ...lastKnown, id: "other", disabled: true };

    expect(getCatalogRefreshNotices([fresh, lastKnown, empty, disabled])).toEqual([
      {
        providerId: "opencode",
        providerLabel: "OpenCode",
        reason: "unterminated opencode models JSON block",
      },
    ]);
  });
});

import { uiI18n } from "@/lib/i18n/ui";
import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@/test-utils";
import type { PrStatusSnapshot } from "@/api/generated";
import { PrDescription, PrRelativeTime } from "./FeaturePrViewParts";

function snapshot(bodyMarkdown: string): PrStatusSnapshot {
  return {
    setup_required: false,
    feature_id: 3,
    fetched_at: 1,
    error: null,
    ci: { state: "passing", checks: [{ name: "build", state: "passing", url: null }] },
    pr: {
      author: { username: "reviewer" },
      body_markdown: bodyMarkdown,
      head_sha: "abc",
      number: 7,
      pr_label: "Pull request",
      review_state: "approved",
      source_branch: "feature/x",
      state: "open",
      target_branch: "main",
      title: "Add a thing",
      updated_at: "2026-07-24T00:00:00Z",
      url: "https://example.test/pr/7",
    },
  };
}

function disclosure(): HTMLElement {
  return screen.getByRole("button", { name: /Description/ });
}

describe("PrDescription", () => {
  it("starts folded so the first review thread is above the fold", () => {
    render(<PrDescription status={snapshot("Rewrites the poller.")} />);

    expect(disclosure()).toHaveAttribute("aria-expanded", "false");
  });

  it("previews the first line of prose, skipping heading markup", () => {
    render(<PrDescription status={snapshot("## Summary\n\nRewrites the **poller**.")} />);

    expect(screen.getByText("Rewrites the poller.")).toBeVisible();
  });

  it("opens on click", () => {
    render(<PrDescription status={snapshot("Rewrites the poller.")} />);

    fireEvent.click(disclosure());

    expect(disclosure()).toHaveAttribute("aria-expanded", "true");
  });

  it("says so plainly rather than offering an empty disclosure", () => {
    render(<PrDescription status={snapshot("   ")} />);

    expect(screen.getByText("No description provided.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Description/ })).not.toBeInTheDocument();
  });
});

it("updates an already displayed PR timestamp with the UI language", async () => {
  const value = new Date(Date.now() - 120_000).toISOString();
  render(<PrRelativeTime value={value} />);
  try {
    expect(screen.getByText("2 minutes ago")).toBeVisible();
    await act(async () => {
      await uiI18n.changeLanguage("fr-CA");
    });
    expect(screen.getByText("il y a 2 minutes")).toBeVisible();
  } finally {
    await act(async () => {
      await uiI18n.changeLanguage("en");
    });
  }
});

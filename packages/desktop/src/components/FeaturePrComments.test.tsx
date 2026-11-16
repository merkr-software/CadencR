import { fireEvent, render, screen } from "@/test-utils";
import { describe, expect, it, vi } from "vitest";
import type { CommentThread } from "@/api/generated";
import { PrCommentThread } from "./FeaturePrComments";
import { CommentsHeader } from "./PrCommentsHeader";

function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: "thread-1",
    resolved: false,
    outdated: false,
    file: "src/app.ts",
    line: 12,
    side: "new",
    comments: [
      {
        author: { username: "alice", display_name: "Alice", avatar_url: null },
        body_markdown: "Please handle the empty state.",
        created_at: "2026-07-20T09:00:00Z",
        url: "https://gitlab.example/group/project/-/merge_requests/8#note_2",
      },
    ],
    ...overrides,
  };
}

describe("PrCommentThread actions", () => {
  it("selects an open thread directly from the PR timeline", () => {
    const onSelectedChange = vi.fn();
    const value = thread();
    const { container, rerender } = render(
      <PrCommentThread thread={value} selected={false} onSelectedChange={onSelectedChange} />,
    );

    fireEvent.click(screen.getByText("src/app.ts:12"));

    // The card reports its own id, so the list can pass one shared callback to
    // every row instead of binding a fresh arrow per row on every render.
    expect(onSelectedChange).toHaveBeenCalledWith(value.id, true);
    rerender(<PrCommentThread thread={value} selected onSelectedChange={onSelectedChange} />);
    expect(container.querySelector("article")).toHaveAttribute("data-selected", "true");
  });

  it("keeps the pick control in the thread header, beside the location", () => {
    const value = thread({
      comments: [
        {
          author: { username: "alice", display_name: "Alice", avatar_url: null },
          body_markdown: "root",
          created_at: "2026-07-20T09:00:00Z",
          url: null,
        },
        {
          author: { username: "bob", display_name: "Bob", avatar_url: null },
          body_markdown: "reply",
          created_at: "2026-07-20T10:00:00Z",
          url: null,
        },
      ],
    });
    render(<PrCommentThread thread={value} onSelectedChange={vi.fn()} />);

    const checkbox = screen.getByRole("checkbox", {
      name: /pick src\/app\.ts:12 for the agent/i,
    });
    // The header row is the box's label: location, status, then the box.
    const header = checkbox.closest("label");
    expect(header).toHaveTextContent("src/app.ts:12");
    expect(header).not.toHaveTextContent("Alice");
    // The author line stays about the comment: who, and when.
    const authorRow = screen.getByText("Alice").closest("div");
    expect(authorRow).not.toContainElement(checkbox);
    // Replies stay author-only — one picker for the thread.
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  });

  it("offers direct current-diff navigation and a provider-aware reply action", () => {
    const onViewThread = vi.fn();
    const value = thread();
    render(<PrCommentThread thread={value} onViewThread={onViewThread} />);

    fireEvent.click(screen.getByRole("button", { name: "View in diff" }));

    expect(onViewThread).toHaveBeenCalledWith(value);
    expect(screen.getByRole("button", { name: "Reply on gitlab.example" })).toBeVisible();
  });

  it("does not pretend outdated or resolved anchors can be found in the current diff", () => {
    const { rerender } = render(
      <PrCommentThread thread={thread({ outdated: true })} onViewThread={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "View in diff" })).toBeNull();

    rerender(<PrCommentThread thread={thread({ resolved: true })} onViewThread={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "View in diff" })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("CommentsHeader", () => {
  it("offers one control that takes every unresolved thread", () => {
    render(
      <CommentsHeader
        commentsLoading={false}
        commentsRefreshing={false}
        commentsError={undefined}
        onRetry={vi.fn()}
        commentCount={2}
        unresolvedCount={2}
        totalCount={2}
        filter="unresolved"
        onFilterChange={vi.fn()}
        selectionEnabled
        onAllSelectedChange={vi.fn()}
      />,
    );

    // One control, no prose: what the checkbox column is for is said by the
    // action bar that acts on it, not by a paragraph above every review.
    expect(
      screen.getByRole("checkbox", { name: /pick all 2 unresolved threads for the agent/i }),
    ).toBeVisible();
    expect(screen.getByText("Pick all")).toBeVisible();
  });

  it("leaves the select-all control out when the caller cannot act on it", () => {
    render(
      <CommentsHeader
        commentsLoading={false}
        commentsRefreshing={false}
        commentsError={undefined}
        onRetry={vi.fn()}
        commentCount={2}
        unresolvedCount={2}
        totalCount={2}
        filter="unresolved"
        onFilterChange={vi.fn()}
        selectionEnabled
      />,
    );

    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

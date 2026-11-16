import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@/test-utils";
import { GitGraphRow, type GitGraphRowData } from "./GitGraphRow";
import type { GraphRow } from "@/lib/git-graph-layout";

const row: GraphRow = {
  commitCol: 0,
  lanesBefore: [null],
  lanesAfter: ["parent"],
  mergeInCols: [],
  parentCols: [0],
};

const commit: GitGraphRowData = {
  sha: "abc123def",
  shortSha: "abc123d",
  message: "Fix the thing",
  body: "",
  author: "rle",
  date: "2026-01-01 12:00:00 +0000",
  isPushed: true,
  parents: ["parent"],
  decorations: [
    { name: "origin/main", kind: "remote" },
    { name: "v1.0", kind: "tag" },
    { name: "feature/x", kind: "head" },
  ],
  filesChanged: 3,
  additions: 10,
  deletions: 2,
};

describe("GitGraphRow", () => {
  it("renders the message, ref pills and file count", () => {
    render(
      <GitGraphRow
        commit={commit}
        row={row}
        columns={1}
        onOpenCommit={vi.fn()}
        onOpenOnline={vi.fn()}
      />,
    );
    expect(screen.getByText("Fix the thing")).toBeInTheDocument();
    expect(screen.getByText("feature/x")).toBeInTheDocument();
    expect(screen.getByText("origin/main")).toBeInTheDocument();
    expect(screen.getByText("3 files")).toBeInTheDocument();
    expect(screen.queryByText("Not pushed")).not.toBeInTheDocument();
  });

  it("orders refs checked-out branch first and tells their kinds apart", () => {
    const { container } = render(
      <GitGraphRow
        commit={commit}
        row={row}
        columns={1}
        onOpenCommit={vi.fn()}
        onOpenOnline={vi.fn()}
      />,
    );
    const kinds = [...container.querySelectorAll("[data-ref-kind]")].map((chip) =>
      chip.getAttribute("data-ref-kind"),
    );
    expect(kinds).toEqual(["head", "remote", "tag"]);
  });

  it("says in words that a commit is not pushed yet", () => {
    render(
      <GitGraphRow
        commit={{ ...commit, isPushed: false }}
        row={row}
        columns={1}
        onOpenCommit={vi.fn()}
        onOpenOnline={vi.fn()}
      />,
    );
    expect(screen.getByText("Not pushed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Fix the thing.*Not pushed/ })).toBeInTheDocument();
  });

  it("opens the commit diff on click", () => {
    const onOpenCommit = vi.fn();
    render(
      <GitGraphRow
        commit={commit}
        row={row}
        columns={1}
        onOpenCommit={onOpenCommit}
        onOpenOnline={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onOpenCommit).toHaveBeenCalledWith("abc123def");
  });
});

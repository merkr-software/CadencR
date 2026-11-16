import { describe, expect, it } from "vitest";
import { render, screen } from "@/test-utils";
import { ProjectAttentionBadges, attentionSummary } from "./ProjectAttentionBadges";

const counts = { waiting: 2, failed: 0, working: 1, unread: 3 };

describe("ProjectAttentionBadges", () => {
  it("summarizes the most urgent first and skips empty states", () => {
    expect(attentionSummary(counts)).toBe("2 waiting, 1 working, 3 unread");
  });

  it("shows numbers in count mode and marks only in dot mode", () => {
    const { rerender } = render(<ProjectAttentionBadges counts={counts} mode="count" />);
    const badge = screen.getByRole("img", { name: "2 waiting, 1 working, 3 unread" });
    expect(badge).toHaveTextContent("213");
    rerender(<ProjectAttentionBadges counts={counts} mode="dot" />);
    expect(screen.getByRole("img")).not.toHaveTextContent(/\d/);
  });

  it("renders nothing for a quiet project", () => {
    const { container } = render(
      <ProjectAttentionBadges
        counts={{ waiting: 0, failed: 0, working: 0, unread: 0 }}
        mode="count"
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

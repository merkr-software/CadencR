import { describe, expect, it } from "vitest";
import { render, screen } from "@/test-utils";
import userEvent from "@testing-library/user-event";

import { SessionHint } from "./SessionHint";
import { translateUi } from "@/lib/i18n/ui";
import { SESSION_HINT_BEHAVIORS } from "./session-hint-behaviors";

/**
 * The hint card is small enough that the only behavior worth pinning is the
 * dedup contract: clicking "Show another tip" must guarantee the rendered
 * combo changes — otherwise the button feels broken on the (rare) collision.
 *
 * We assert across N clicks that *every* successive combo differs from the
 * one before. With 50+ behaviors and 13+ shortcut scope groups, randomness
 * is fine; the assertion catches regressions to the `pickHint` filter.
 */
describe("SessionHint", () => {
  it("renders both a shortcut description and a behavior tip", () => {
    render(<SessionHint />);
    expect(screen.getByText("Start your first turn")).toBeInTheDocument();
    // The behavior list is finite — at least one of its entries must appear.
    const behaviorMatches = SESSION_HINT_BEHAVIORS.some(
      (b) => screen.queryByText(b(translateUi)) !== null,
    );
    expect(behaviorMatches).toBe(true);
  });

  it("never repeats the same combo across consecutive re-rolls", async () => {
    const user = userEvent.setup();
    render(<SessionHint />);
    const button = screen.getByRole("button", { name: /show another tip/i });

    const snapshot = (): { description: string; behavior: string } => {
      // The shortcut description sits next to the `<kbd>` chord; the behavior
      // is the text of the second section. Grabbing the section roles keeps
      // the assertion robust to chord-rendering tweaks.
      const card = screen.getByRole("button", { name: /show another tip/i })
        .previousElementSibling as HTMLElement;
      const sections = card.querySelectorAll("section");
      return {
        description: sections[0]?.textContent ?? "",
        behavior: sections[1]?.textContent ?? "",
      };
    };

    const seen = [snapshot()];
    for (let i = 0; i < 5; i += 1) {
      await user.click(button);
      const current = snapshot();
      const prev = seen[seen.length - 1];
      expect(current.description === prev.description && current.behavior === prev.behavior).toBe(
        false,
      );
      seen.push(current);
    }
  });
});

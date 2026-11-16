import { describe, expect, it } from "vitest";
import { render, screen } from "@/test-utils";
import { ErrorBlock } from "./ErrorBlock";

describe("ErrorBlock", () => {
  it("shows a hidden tool's failure as is", () => {
    render(<ErrorBlock content="Runtime coordination failed" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Runtime coordination failed");
  });

  it("leads a turn-ending error with plain words and keeps the raw text one click away", async () => {
    const { user } = render(
      <ErrorBlock
        blockId="msg-9"
        code="ERROR_DURING_EXECUTION"
        content="Claude Code ended the turn with an error (error_during_execution): 529 overloaded"
      />,
    );
    expect(screen.getByText("The provider is overloaded or rate-limited")).toBeInTheDocument();
    expect(screen.queryByText(/529 overloaded/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Details · ERROR_DURING_EXECUTION/ }));
    expect(screen.getByText(/529 overloaded/)).toBeInTheDocument();
    // Outside a live session there is no turn to continue: no recovery buttons.
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
  });
});

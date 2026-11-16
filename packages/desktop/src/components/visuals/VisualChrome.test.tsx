import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/test-utils";
import { VisualChrome } from "./VisualChrome";

const CODE = '{"mark": "bar"}';

function renderChrome() {
  return render(
    <VisualChrome label="Chart" icon={null} code={CODE} sourceLanguage="json">
      <div data-testid="rendered">chart</div>
    </VisualChrome>,
  );
}

describe("VisualChrome", () => {
  it("shows the visual bare, without a code-block header", () => {
    renderChrome();
    expect(screen.getByTestId("rendered")).toBeInTheDocument();
    expect(screen.queryByText("Chart")).not.toBeInTheDocument();
    expect(document.querySelector("[data-code-block]")).toBeNull();
  });

  it("swaps to the source as a code block and back", () => {
    renderChrome();
    fireEvent.click(screen.getByRole("button", { name: "View source" }));
    expect(screen.queryByTestId("rendered")).not.toBeInTheDocument();
    expect(document.querySelector("[data-code-block]")).not.toBeNull();
    expect(document.querySelector("pre")).toHaveTextContent(CODE);
    fireEvent.click(screen.getByTitle("View chart"));
    expect(screen.getByTestId("rendered")).toBeInTheDocument();
  });

  it("virtualizes a large source like any large code block", () => {
    const large = Array.from({ length: 500 }, (_, index) => `<p>${index}</p>`).join("\n");
    render(
      <VisualChrome label="Visual" icon={null} code={large} sourceLanguage="html">
        <div data-testid="rendered">visual</div>
      </VisualChrome>,
    );
    fireEvent.click(screen.getByRole("button", { name: "View source" }));
    expect(screen.getByText(/Large code — virtualized/)).toBeInTheDocument();
    expect(screen.getByTitle("View visual")).toBeInTheDocument();
  });

  it("copies the source from the floating actions", async () => {
    renderChrome();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    fireEvent.click(screen.getByRole("button", { name: "Copy source" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CODE));
  });
});

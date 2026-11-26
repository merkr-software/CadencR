import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { BrowserTabError } from "@/lib/desktop-bridge";
import { BrowserPageError } from "./BrowserPageError";

function makeError(overrides: Partial<BrowserTabError> = {}): BrowserTabError {
  return {
    kind: "load",
    title: "This site can’t be reached",
    description: "localhost refused to connect. Make sure your dev server is running.",
    url: "http://localhost:5175/signup",
    code: "ERR_CONNECTION_REFUSED",
    retryable: true,
    ...overrides,
  };
}

describe("BrowserPageError", () => {
  it("renders structured load error details and triggers retry", () => {
    const onRetry = vi.fn();
    const { container } = render(<BrowserPageError error={makeError()} onRetry={onRetry} />);

    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByRole("heading", { name: "This site can’t be reached" })).toBeVisible();
    expect(
      screen.getByText("localhost refused to connect. Make sure your dev server is running."),
    ).toBeVisible();
    expect(screen.getByText("http://localhost:5175/signup")).toBeVisible();
    expect(screen.getByText("ERR_CONNECTION_REFUSED")).toBeVisible();
    expect(container.querySelector("svg.text-muted-foreground")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("chooses the icon strictly from error.kind rather than code prefixes", () => {
    const { container: securityContainer } = render(
      <BrowserPageError
        error={makeError({
          kind: "security",
          title: "Your connection is not private",
          code: "CUSTOM_SECURITY_CODE",
        })}
        onRetry={vi.fn()}
      />,
    );
    expect(securityContainer.querySelector("svg.text-\\[var\\(--acc-orange\\)\\]")).not.toBeNull();

    const { container: loadContainer } = render(
      <BrowserPageError
        error={makeError({
          kind: "load",
          code: "ERR_CERT_AUTHORITY_INVALID",
        })}
        onRetry={vi.fn()}
      />,
    );
    expect(loadContainer.querySelector("svg.text-muted-foreground")).not.toBeNull();
    expect(loadContainer.querySelector("svg.text-\\[var\\(--acc-orange\\)\\]")).toBeNull();
  });

  it("shows busy state while retrying", () => {
    render(<BrowserPageError error={makeError()} onRetry={vi.fn()} retrying />);

    const button = screen.getByRole("button", { name: "Retrying…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("hides the retry button when retryable is false", () => {
    render(
      <BrowserPageError
        error={makeError({
          kind: "crash",
          title: "This tab crashed",
          description: "The renderer process exited unexpectedly.",
          retryable: false,
          url: undefined,
          code: "CRASHED",
        })}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "This tab crashed" })).toBeVisible();
    expect(screen.getByText("CRASHED")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });
});

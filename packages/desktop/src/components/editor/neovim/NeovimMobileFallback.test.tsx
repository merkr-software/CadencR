import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import NeovimMobileFallback from "./NeovimMobileFallback";

describe("NeovimMobileFallback", () => {
  it("explains why full Neovim is unavailable", () => {
    render(<NeovimMobileFallback />);
    expect(screen.getByText(/not available on mobile/i)).toBeInTheDocument();
  });
});

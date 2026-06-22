import { describe, it, expect } from "vitest";
import { render } from "@/test-utils";
import { NumStat } from "./NumStat";

describe("NumStat", () => {
  it("hides a zero side by default", () => {
    const { queryByText } = render(<NumStat additions={86} deletions={0} />);
    expect(queryByText("+86")).toBeInTheDocument();
    expect(queryByText("-0")).not.toBeInTheDocument();
  });

  it("renders nothing when both sides are zero", () => {
    const { container } = render(<NumStat additions={0} deletions={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a zero side when hideZero is disabled", () => {
    const { queryByText } = render(<NumStat additions={86} deletions={0} hideZero={false} />);
    expect(queryByText("+86")).toBeInTheDocument();
    expect(queryByText("-0")).toBeInTheDocument();
  });

  it("applies explicit color overrides", () => {
    const { getByText } = render(
      <NumStat additions={3} deletions={2} addColor="#5ecc71" delColor="#ff6762" />,
    );
    expect(getByText("+3")).toHaveStyle({ color: "#5ecc71" });
    expect(getByText("-2")).toHaveStyle({ color: "#ff6762" });
  });
});

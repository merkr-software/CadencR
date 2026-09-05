import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModelMetaChip } from "./ModelMetaChip";

describe("ModelMetaChip", () => {
  it("renders a loading state when no selection is confirmed", () => {
    render(
      <ModelMetaChip
        open={false}
        onOpenChange={() => {}}
        selection={null}
        pickerProviders={[]}
        canChangeProvider={false}
        supportedThinkingEfforts={[]}
      />,
    );

    expect(screen.getByLabelText("Loading model catalog")).toBeInTheDocument();
  });
});

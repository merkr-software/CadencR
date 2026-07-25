import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@/test-utils";
import type { Project, SaveScheduleRequest } from "@/api/generated";
import { ScheduleEditorDialog } from "./ScheduleEditorDialog";

const { mockUseListFeatures } = vi.hoisted(() => ({ mockUseListFeatures: vi.fn() }));

vi.mock("@/api/generated", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/generated")>()),
  useListFeatures: (...args: unknown[]) => mockUseListFeatures(...args),
}));

// The composer has its own test; here it only has to feed prompt text back.
vi.mock("./ScheduleComposer", () => ({
  ScheduleComposer: ({ onPromptChange }: { onPromptChange: (prompt: string) => void }) => (
    <button type="button" onClick={() => onPromptChange("Review yesterday's diffs")}>
      write prompt
    </button>
  ),
}));

const PROJECTS: Project[] = [{ id: 1, name: "cadencr", path: "/tmp/cadencr" } as Project];

type SaveFn = (body: SaveScheduleRequest, id?: number) => Promise<unknown>;

function dialog(onSave: SaveFn) {
  // Fresh object/array identities on purpose: that is what the real callers
  // pass, and what used to reset the form mid-edit.
  return (
    <ScheduleEditorDialog
      open
      onOpenChange={vi.fn()}
      projects={[...PROJECTS]}
      onSave={onSave}
      lockedConversation={{ featureId: 7, projectId: 1 }}
    />
  );
}

function renderDialog(onSave: SaveFn) {
  return render(dialog(onSave));
}

describe("ScheduleEditorDialog", () => {
  beforeEach(() => {
    mockUseListFeatures.mockReturnValue({ data: [], isLoading: false, isError: false });
  });

  it("saves on Cmd+Enter, the same as every other dialog", async () => {
    const onSave = vi.fn<SaveFn>().mockResolvedValue(undefined);
    const { user } = renderDialog(onSave);
    await user.click(screen.getByRole("button", { name: "write prompt" }));

    fireEvent.keyDown(document.body, { key: "Enter", code: "Enter", metaKey: true });

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({ prompt: "Review yesterday's diffs" });
  });

  // Regression: the reset effect depended on the `lockedConversation` and
  // `projects` props, which callers build inline. Any re-render of the
  // conversation behind the dialog — constant while an agent streams — threw
  // away what had been typed and remounted the prompt editor.
  it("keeps the draft when the surrounding component re-renders", async () => {
    const onSave = vi.fn<SaveFn>().mockResolvedValue(undefined);
    const { user, rerender } = renderDialog(onSave);
    await user.click(screen.getByRole("button", { name: "write prompt" }));
    await user.type(screen.getByRole("textbox", { name: /Name/ }), "Nightly sweep");

    rerender(dialog(onSave));

    expect(screen.getByRole("textbox", { name: /Name/ })).toHaveValue("Nightly sweep");
    fireEvent.keyDown(document.body, { key: "Enter", code: "Enter", metaKey: true });
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0]).toMatchObject({
      name: "Nightly sweep",
      prompt: "Review yesterday's diffs",
    });
  });

  // The shortcut must not be a way around the validation the button enforces:
  // an empty prompt is the one thing a schedule cannot be saved without.
  it("does nothing while the draft is not saveable", async () => {
    const onSave = vi.fn<SaveFn>().mockResolvedValue(undefined);
    renderDialog(onSave);

    fireEvent.keyDown(document.body, { key: "Enter", code: "Enter", metaKey: true });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Create schedule/ })).toBeDisabled(),
    );
    expect(onSave).not.toHaveBeenCalled();
  });
});

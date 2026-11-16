import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test-utils";
import { CodexProfileEditor } from "./CodexProfileEditor";

const mocks = vi.hoisted(() => ({
  save: { mutate: vi.fn(), isPending: false },
  validate: { mutate: vi.fn(), isPending: false, data: undefined as unknown },
}));

vi.mock("@/api/codexProfiles", () => ({
  useSaveCodexProfile: () => mocks.save,
  useValidateCodexProfile: () => mocks.validate,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const initial = {
  id: "profile-id",
  name: "Work account",
  config_path: "/tmp/work/config.toml",
  effective_home: "/tmp/work",
  env_keys: ["OPENAI_API_KEY"],
  env_unset: ["CODEX_API_KEY"],
  is_active: false,
  revision: "rev-1",
};

describe("CodexProfileEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.save.isPending = false;
    mocks.validate.isPending = false;
    mocks.validate.data = undefined;
  });

  it("preserves masked stored values when their blank row is unchanged", async () => {
    const user = userEvent.setup();
    render(<CodexProfileEditor initial={initial} onClose={vi.fn()} />);

    expect(screen.getByLabelText("Name")).toHaveValue("Work account");
    expect(screen.getByPlaceholderText("Stored value (leave blank to preserve)")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    expect(mocks.save.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "profile-id",
        env: {},
        preserve_env_keys: ["OPENAI_API_KEY"],
        env_unset: ["CODEX_API_KEY"],
      }),
      expect.any(Object),
    );
  });

  it("shows local validation details without claiming Codex compatibility", async () => {
    const user = userEvent.setup();
    const result = {
      valid: false,
      validation_scope: "local_syntax",
      codex_compatible: null,
      errors: [{ field: "config_path", code: "INVALID_PATH", message: "Use an absolute path" }],
      effective_home: null,
      config_exists: false,
      revision: null,
    };
    mocks.validate.data = result;
    mocks.validate.mutate.mockImplementation((_draft, options) => options.onSuccess(result));
    render(<CodexProfileEditor onClose={vi.fn()} />);

    await user.type(screen.getByLabelText("Name"), "QA profile");
    await user.click(screen.getByRole("button", { name: "Validate" }));

    expect(await screen.findByText("Use an absolute path")).toBeInTheDocument();
    expect(screen.getByTitle(/does not prove Codex compatibility/i)).toBeInTheDocument();
  });

  it("explains standard versus custom Codex configuration", () => {
    render(<CodexProfileEditor onClose={vi.fn()} />);

    expect(
      screen.getByText(/Leave blank to use your usual Codex home and configuration/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/separate authentication, history, and state/i)).toBeInTheDocument();
    expect(screen.getByText(/may need to sign in again/i)).toBeInTheDocument();
    expect(screen.getByText(/Cadencr never edits the source file/i)).toBeInTheDocument();
  });

  it("bounds long-profile editing to the viewport with a scrolling body", () => {
    const longName =
      "Settings design QA with a long profile name to check truncation and layout in a narrow window";
    render(<CodexProfileEditor initial={{ ...initial, name: longName }} onClose={vi.fn()} />);

    expect(screen.getByRole("dialog")).toHaveClass(
      "max-h-(--dialog-max-h)",
      "flex",
      "flex-col",
      "overflow-hidden",
    );
    expect(screen.getByRole("heading", { name: `Edit profile “${longName}”` })).toHaveClass(
      "truncate",
    );
    expect(document.querySelector(".min-h-0.flex-1.overflow-y-auto")).toBeInTheDocument();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@/test-utils";
import { NotificationsStep } from "./NotificationsStep";

interface Capabilities {
  isPending: boolean;
  isError: boolean;
  isLoading: boolean;
  data?: { supported: boolean; hardware: boolean };
}
interface ModeSetting {
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  data?: { value: string | null };
}

let capabilities: Capabilities;
let modeSetting: ModeSetting;
const setValue = vi.fn<(value: string) => Promise<boolean>>();

vi.mock("@/components/notch/useNotchCapabilities", () => ({
  useNotchCapabilities: () => capabilities,
}));
vi.mock("@/api/generated", () => ({ useGetWorkspaceSetting: () => modeSetting }));
vi.mock("@/hooks/useSetting", () => ({
  useSettingWriter: () => ({ setValue, isSaving: false }),
}));

function mac(hardware: boolean): Capabilities {
  return {
    isPending: false,
    isError: false,
    isLoading: false,
    data: { supported: true, hardware },
  };
}

function stored(value: string | null): ModeSetting {
  return { isPending: false, isError: false, error: null, data: { value } };
}

function renderStep() {
  const onAdvance = vi.fn();
  render(
    <NotificationsStep
      isPersisting={false}
      onAdvance={onAdvance}
      onBack={vi.fn()}
      onSkipStep={vi.fn()}
    />,
  );
  return { onAdvance };
}

function checkedOption(): string {
  return screen.getByRole("radio", { checked: true }).textContent ?? "";
}

describe("NotificationsStep", () => {
  beforeEach(() => {
    setValue.mockReset();
    setValue.mockResolvedValue(true);
  });

  it("recommends the notch when a notched display is connected", async () => {
    capabilities = mac(true);
    modeSetting = stored(null);
    const { onAdvance } = renderStep();
    expect(checkedOption()).toMatch(/^NotchRecommended/);

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(setValue).toHaveBeenCalledExactlyOnceWith("notch");
    expect(onAdvance).toHaveBeenCalledOnce();
  });

  it("recommends system notifications on a Mac without a notch", () => {
    capabilities = mac(false);
    modeSetting = stored(null);
    renderStep();
    expect(checkedOption()).toMatch(/^SystemRecommended/);
  });

  it("hides the notch where the island can't run (Linux, remote browsers)", () => {
    capabilities = { ...mac(false), data: { supported: false, hardware: false } };
    modeSetting = stored(null);
    renderStep();
    expect(screen.queryByRole("radio", { name: /notch/i })).not.toBeInTheDocument();
    expect(checkedOption()).toMatch(/^SystemRecommended/);
  });

  it("keeps a stored choice and doesn't rewrite it", async () => {
    capabilities = mac(true);
    modeSetting = stored("off");
    const { onAdvance } = renderStep();
    expect(checkedOption()).toMatch(/^Off/);

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(setValue).not.toHaveBeenCalled();
    expect(onAdvance).toHaveBeenCalledOnce();
  });

  it("stays on the step when saving fails", async () => {
    capabilities = mac(true);
    modeSetting = stored(null);
    setValue.mockResolvedValueOnce(false);
    const { onAdvance } = renderStep();

    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it("shows a failed settings read instead of guessing over it", () => {
    capabilities = mac(true);
    modeSetting = { isPending: false, isError: true, error: new Error("offline") };
    renderStep();
    expect(screen.getByRole("alert")).toHaveTextContent(/offline/);
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });
});

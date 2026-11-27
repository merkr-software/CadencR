import { uiI18n } from "@/lib/i18n/ui";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { FontSelector } from "./FontSelector";

const setFamily = vi.fn();
let monoState = {
  family: null as string | null,
  resolved: "monospace",
  setFamily,
  isLoading: false,
};
const load = vi.fn();
let systemState = { fonts: ["Fira Code", "JetBrains Mono"], isLoading: false, error: false, load };
const toastError = vi.fn();

vi.mock("@/lib/fonts/mono-font-setting", () => ({ useMonoFont: () => monoState }));
vi.mock("@/lib/fonts/useSystemFonts", () => ({ useSystemFonts: () => systemState }));
vi.mock("sonner", () => ({ toast: { error: (m: string) => toastError(m) } }));

afterEach(async () => {
  await act(() => uiI18n.changeLanguage("en"));
  uiI18n.removeResourceBundle("fr", "ui");
});

beforeEach(() => {
  setFamily.mockClear();
  toastError.mockClear();
  load.mockClear();
  monoState = { family: null, resolved: "monospace", setFamily, isLoading: false };
  systemState = { fonts: ["Fira Code", "JetBrains Mono"], isLoading: false, error: false, load };
});

describe("FontSelector", () => {
  it("renders the preview in the resolved font", () => {
    monoState.resolved = `"Fira Code", monospace`;
    render(<FontSelector />);
    const preview = screen.getByTestId("mono-font-preview");
    expect(preview).toHaveStyle({ fontFamily: `"Fira Code", monospace` });
  });

  it("loads fonts only once the combobox is opened by the user", () => {
    render(<FontSelector />);
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("combobox"));
    expect(load).toHaveBeenCalledWith(false);
  });

  it("lists detected fonts each rendered in their own family and persists a choice", () => {
    render(<FontSelector />);
    fireEvent.click(screen.getByRole("combobox"));
    const option = screen.getByRole("option", { name: /Fira Code/ });
    expect(option).toHaveStyle({ fontFamily: `"Fira Code"` });
    fireEvent.click(option);
    expect(setFamily).toHaveBeenCalledWith("Fira Code");
  });

  it("keeps Default searchable and selects the empty default value", () => {
    render(<FontSelector />);
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.change(screen.getByPlaceholderText("Search fonts…"), {
      target: { value: "default" },
    });

    fireEvent.click(screen.getByRole("option", { name: /Default/ }));

    expect(setFamily).toHaveBeenCalledWith("");
  });

  it("shows and disables the selector while the setting loads", () => {
    monoState.isLoading = true;
    render(<FontSelector />);

    expect(screen.getByRole("combobox", { name: "Monospace font" })).toBeDisabled();
    expect(screen.getByText("Loading…")).toBeVisible();
  });

  it("shows a warning and toasts once when detection fails", () => {
    systemState = { fonts: [], isLoading: false, error: true, load };
    render(<FontSelector />);
    expect(screen.getByText(/detection unavailable/i)).toBeInTheDocument();
    expect(toastError).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("combobox"));
    expect(within(screen.getByRole("listbox")).getByText(/Default/)).toBeInTheDocument();
  });
});

it("updates an open font list and finds Default by its translated display label", async () => {
  render(<FontSelector />);
  fireEvent.click(screen.getByRole("combobox", { name: "Monospace font" }));
  const input = screen.getByPlaceholderText("Search fonts…");
  input.focus();
  const defaultOption = screen.getByRole("option", { name: "Default" });
  fireEvent.change(input, { target: { value: "default" } });

  uiI18n.addResourceBundle("fr", "ui", {
    appearance: {
      font: {
        default: "Par défaut",
        search: "Chercher des polices…",
        results: "Polices trouvées",
      },
    },
  });
  await act(() => uiI18n.changeLanguage("fr"));

  expect(screen.getByPlaceholderText("Chercher des polices…")).toBe(input);
  expect(input).toHaveValue("default");
  expect(input).toHaveFocus();
  expect(screen.getByRole("option", { name: "Par défaut" })).toBe(defaultOption);
  fireEvent.change(input, { target: { value: "par défaut" } });
  expect(screen.getByRole("option", { name: "Par défaut" })).toBe(defaultOption);

  await act(() => uiI18n.changeLanguage("en"));
  expect(screen.getByPlaceholderText("Search fonts…")).toBe(input);
  expect(screen.getByText("No matching fonts.")).toBeVisible();
  await act(() => uiI18n.changeLanguage("fr"));
  expect(input).toHaveValue("par défaut");

  const localizedDefault = screen.getByRole("option", { name: "Par défaut" });
  await waitFor(() => expect(localizedDefault).toHaveAttribute("aria-selected", "true"));
  expect(input).toHaveFocus();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(setFamily).toHaveBeenCalledWith("");
});

it("navigates filtered font options by arrow and commits the raw family with Enter", async () => {
  systemState.fonts = ["Fira Mono", "JetBrains Mono"];
  render(<FontSelector />);
  fireEvent.click(screen.getByRole("combobox", { name: "Monospace font" }));
  const input = screen.getByPlaceholderText("Search fonts…");

  fireEvent.change(input, { target: { value: "mono" } });
  const first = screen.getByRole("option", { name: "Fira Mono" });
  const second = screen.getByRole("option", { name: "JetBrains Mono" });
  await waitFor(() => expect(first).toHaveAttribute("aria-selected", "true"));

  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(second).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(setFamily).toHaveBeenCalledWith("JetBrains Mono");
});

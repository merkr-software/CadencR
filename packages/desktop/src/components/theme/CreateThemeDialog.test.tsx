import { uiI18n } from "@/lib/i18n/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/test-utils";
import type { ThemeDefinition } from "@/lib/themes";
import { CADENCR_THEME_LOGOS } from "@/lib/themes/logos";
import { CreateThemeDialog } from "./CreateThemeDialog";

const onCreate = vi.fn();
const onClose = vi.fn();

const MINE: ThemeDefinition = {
  id: "user:vamp",
  label: "Vamp",
  appearance: "dark",
  logo: CADENCR_THEME_LOGOS.dark,
  cssVars: {} as ThemeDefinition["cssVars"],
  swatch: { background: "#000", foreground: "#fff", primary: "#f0f", accent: "#0ff" },
  xterm: {} as ThemeDefinition["xterm"],
};

function renderDialog(overrides: { isCreating?: boolean; userThemes?: ThemeDefinition[] } = {}) {
  return render(
    <CreateThemeDialog
      userThemes={overrides.userThemes ?? []}
      isCreating={overrides.isCreating ?? false}
      onCreate={onCreate}
      onClose={onClose}
    />,
  );
}

const createButton = (): HTMLElement => screen.getByRole("button", { name: "Create theme" });
const nameField = (): HTMLElement => screen.getByLabelText("Name");
const card = (name: RegExp): HTMLElement => screen.getByRole("radio", { name });

afterEach(async () => {
  await act(() => uiI18n.changeLanguage("en"));
  uiI18n.removeResourceBundle("fr", "ui");
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("CreateThemeDialog", () => {
  it("won't create until the theme has both a base and a name", async () => {
    const { user } = renderDialog();

    expect(createButton()).toBeDisabled();

    await user.click(card(/dracula/i));
    expect(createButton()).toBeDisabled();

    await user.type(nameField(), "Midnight Ember");
    expect(createButton()).toBeEnabled();
  });

  it("creates the theme under the name the user gave it", async () => {
    const { user } = renderDialog();

    await user.click(card(/dracula/i));
    await user.type(nameField(), "  Midnight Ember  ");
    await user.click(createButton());

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "dracula" }),
      "Midnight Ember",
    );
  });

  it("submits on Enter, so naming and creating is one gesture", async () => {
    const { user } = renderDialog();

    await user.click(card(/dracula/i));
    await user.type(nameField(), "Midnight Ember{Enter}");

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "dracula" }),
      "Midnight Ember",
    );
  });

  it("refuses a name that is only whitespace", async () => {
    const { user } = renderDialog();

    await user.click(card(/dracula/i));
    await user.type(nameField(), "   ");

    expect(createButton()).toBeDisabled();
  });

  it("caps the name at what the backend will accept", () => {
    renderDialog();

    expect(nameField()).toHaveAttribute("maxLength", "64");
  });

  it("offers the user's own themes to start from", async () => {
    const { user } = renderDialog({ userThemes: [MINE] });

    await user.click(card(/vamp/i));
    await user.type(nameField(), "Vamp Noir");
    await user.click(createButton());

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "user:vamp" }),
      "Vamp Noir",
    );
  });

  it("moves the choice with the arrow keys", async () => {
    const { user } = renderDialog();

    await user.click(card(/cadencr dark/i));
    await user.keyboard("{ArrowRight}");

    expect(card(/cadencr light/i)).toBeChecked();
    expect(card(/cadencr dark/i)).not.toBeChecked();
  });

  it("locks the form while the copy is being made", () => {
    renderDialog({ isCreating: true });

    expect(nameField()).toBeDisabled();
    expect(card(/dracula/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /creating/i })).toBeDisabled();
  });
});

it("updates built-in copy without replacing the draft, selected base or authored names", async () => {
  const personalTheme: ThemeDefinition = { ...MINE, label: "CadencR Dark" };
  const { user } = renderDialog({ userThemes: [personalTheme] });
  const personalCard = screen.getAllByRole("radio", { name: /CadencR Dark/i }).at(-1);
  const darkCard = card(/Dracula/i);
  await user.click(darkCard);
  const draft = nameField();
  await user.type(draft, "Crépuscule");
  expect(draft).toHaveFocus();

  uiI18n.addResourceBundle("fr", "ui", {
    appearance: {
      library: { name: "Nom du thème", create: "Créer le thème", startingFrom: "Base : {{theme}}" },
      theme: { dark: "sombre" },
      themes: { cadencrDark: "CadencR Sombre", dracula: "Dracula français" },
    },
  });
  await act(() => uiI18n.changeLanguage("fr"));

  expect(screen.getByLabelText("Nom du thème")).toBe(draft);
  expect(draft).toHaveFocus();
  expect(draft).toHaveValue("Crépuscule");
  expect(card(/Dracula français/)).toBe(darkCard);
  expect(darkCard).toBeChecked();
  expect(darkCard).toHaveAttribute("data-theme-card", "dracula");
  expect(screen.getByText("Base : Dracula français")).toBeVisible();
  expect(card(/CadencR Sombre/)).toBeVisible();
  expect(card(/CadencR Dark/)).toBe(personalCard);

  await user.click(screen.getByRole("button", { name: "Créer le thème" }));
  expect(onCreate).toHaveBeenCalledWith(
    expect.objectContaining({ id: "dracula", label: "Dracula", appearance: "dark" }),
    "Crépuscule",
  );
});

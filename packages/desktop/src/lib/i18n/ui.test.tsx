import { afterEach, expect, it } from "vitest";
import { act, render, screen } from "@/test-utils";
import { translateUi, UiTrans, uiI18n, useUiTranslation } from "./ui";

function ItemCount() {
  const { t } = useUiTranslation();
  return <p>{t("test.itemCount", "{{count}} items", { count: 2 })}</p>;
}

afterEach(async () => {
  await act(async () => {
    await uiI18n.changeLanguage("en");
  });
  uiI18n.removeResourceBundle("fr", "ui");
});

it("renders English defaults and updates mounted text and actions together", async () => {
  render(
    <>
      <ItemCount />
      <UiTrans
        i18nKey="test.open"
        defaults="Open <action>settings</action> for {{name}}."
        values={{ name: "Ada" }}
        components={{ action: <button type="button" /> }}
      />
    </>,
  );
  expect(screen.getByText("2 items")).toBeVisible();
  const action = screen.getByRole("button", { name: "settings" });
  expect(action.parentElement).toHaveTextContent("Open settings for Ada.");

  uiI18n.addResourceBundle("fr", "ui", {
    test: { itemCount_other: "[{{count}}]", open: "{{name}} <action>[action]</action>" },
  });
  await act(async () => {
    await uiI18n.changeLanguage("fr");
  });
  expect(screen.getByText("[2]")).toBeVisible();
  expect(screen.getByRole("button", { name: "[action]" })).toBe(action);
  expect(action.parentElement).toHaveTextContent("Ada [action]");
  expect(translateUi("test.itemCount", "{{count}} items", { count: 2 })).toBe("[2]");
  expect(translateUi("test.missing", "Hello {{name}}", { name: "Ada" })).toBe("Hello Ada");
});

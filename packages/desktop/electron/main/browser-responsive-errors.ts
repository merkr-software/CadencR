import { translateUi as t } from "../../src/shared/ui-i18n";

export const responsiveErrors = {
  setFailedRestored: (detail: string) =>
    t(
      "workspace.browser.responsive.setFailedRestored",
      "Could not update responsive mode. The previous settings were restored. {{detail}}",
      { detail },
    ),
  invalidConfiguration: () =>
    t(
      "workspace.browser.responsive.invalidConfiguration",
      "Invalid Browser responsive viewport configuration.",
    ),
};

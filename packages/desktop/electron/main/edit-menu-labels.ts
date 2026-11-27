import { translateUi } from "../../src/shared/ui-i18n";

export const editMenuLabels = {
  undo: () => translateUi("native.menu.undo", "Undo"),
  redo: () => translateUi("native.menu.redo", "Redo"),
  cut: () => translateUi("native.menu.cut", "Cut"),
  copy: () => translateUi("native.menu.copy", "Copy"),
  paste: () => translateUi("native.menu.paste", "Paste"),
  selectAll: () => translateUi("native.menu.selectAll", "Select All"),
};

import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/api-errors";
import { builtinNeovimEditor } from "@/components/editor/neovim/editor-adapter";
import { EditorNavigationController } from "./editor-navigation";
import { editorSurfaces } from "./editor-surfaces";

export const editorNavigation = new EditorNavigationController({
  surfaces: editorSurfaces,
  builtin: builtinNeovimEditor,
  report: (error) =>
    toast.error("Could not open the selected editor", {
      description: apiErrorMessage(error, "Cannot open file"),
    }),
});

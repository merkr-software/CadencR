import { forwardRef, memo } from "react";
import { createPortal } from "react-dom";
import { MobileTerminalKeyBar } from "./MobileTerminalKeyBar";
import { TerminalPaneToolbar } from "./TerminalPaneToolbar";
import { TerminalSplitTree } from "./TerminalSplitTree";
import {
  useTerminalPanelController,
  type TerminalPanelController,
  type TerminalPanelHandle,
  type TerminalPanelProps,
} from "./useTerminalPanelController";
import { TerminalCoreInstance } from "@/components/terminal-core";

export type { TerminalPanelHandle } from "./useTerminalPanelController";

export const TerminalPanel = memo(
  forwardRef<TerminalPanelHandle, TerminalPanelProps>(function TerminalPanel(props, ref) {
    const controller = useTerminalPanelController(props, ref);
    return (
      <div
        className="relative flex h-full flex-col"
        data-focus-zone="terminal"
        tabIndex={0}
        onFocus={(event) => {
          if (event.target === event.currentTarget) controller.focus.focusFirstPane();
        }}
      >
        <TerminalPanelLayout props={props} controller={controller} />
        <TerminalPortals props={props} controller={controller} />
      </div>
    );
  }),
);

function TerminalPanelLayout({
  props,
  controller,
}: {
  props: TerminalPanelProps;
  controller: TerminalPanelController;
}) {
  return (
    <>
      <TerminalPaneToolbar
        canClose={controller.leaves.length > 0}
        onClose={controller.layout.closeActivePane}
        onSplit={controller.layout.splitAndFocus}
      />
      <div
        className="min-h-0 flex-1 overflow-hidden transition-[height] duration-150 ease-in-out"
        style={props.state.isMinimized ? { height: 0, minHeight: 0 } : undefined}
      >
        {props.state.root && (
          <TerminalSplitTree
            node={props.state.root}
            expectedCwd={props.expectedCwd}
            warnPaneIds={controller.runtime.warnPaneIds}
            onFocusPane={controller.focus.focusPane}
            onSplitPane={controller.layout.splitPaneAndFocus}
            onClosePane={controller.layout.closePane}
            onCopyPane={controller.runtime.copyPaneSelection}
            onPastePane={controller.runtime.pasteIntoPane}
            onRestartPane={controller.runtime.restartPane}
            onDismissWarning={controller.runtime.dismissPaneWarning}
            onRegisterPlaceholder={controller.slots.registerPlaceholder}
          />
        )}
      </div>
      {controller.isMobile && controller.leaves.length > 0 && !props.state.isMinimized && (
        <MobileTerminalKeyBar
          ctrlArmed={controller.focus.ctrlArmed}
          onToggleCtrl={controller.focus.toggleCtrl}
          onSendKey={controller.focus.sendKeyToActivePane}
        />
      )}
    </>
  );
}

function TerminalPortals({
  props,
  controller,
}: {
  props: TerminalPanelProps;
  controller: TerminalPanelController;
}) {
  return controller.slots.activeSlots.map(({ leaf, slot }) =>
    createPortal(
      <TerminalCoreInstance
        key={leaf.id}
        ref={(handle) => controller.focus.setPaneRef(leaf.id, handle)}
        featureId={props.featureId}
        projectId={props.projectId}
        existingPtyId={leaf.ptyId}
        requestedCwd={props.expectedCwd ?? undefined}
        initialCommand={leaf.initialCommand}
        onInitialCommandConsumed={() => controller.clearInitialCommand(props.featureId, leaf.id)}
        initialNotice={leaf.initialNotice}
        onInitialNoticeConsumed={() => controller.clearInitialNotice(props.featureId, leaf.id)}
        onPtyReady={(ptyId, cwd) => {
          controller.setPtyId(props.featureId, leaf.id, ptyId);
          if (cwd) controller.setPaneCwd(props.featureId, leaf.id, cwd);
        }}
        onExit={(ptyId) => controller.runtime.handlePaneExit(ptyId, leaf.id)}
        onTerminalFocus={() => controller.focus.setActivePane(leaf.id)}
        ctrlArmed={controller.focus.ctrlArmed}
        onConsumeCtrl={controller.focus.consumeCtrl}
      />,
      slot,
      leaf.id,
    ),
  );
}

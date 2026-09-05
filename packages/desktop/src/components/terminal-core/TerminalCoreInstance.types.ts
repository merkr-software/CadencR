export interface TerminalCoreInstanceProps {
  featureId: number;
  projectId: number;
  existingPtyId?: string;
  requestedCwd?: string;
  onExit?: (ptyId: string) => void;
  onPtyReady?: (ptyId: string, cwd: string | null) => void;
  killOnUnmount?: boolean;
  initialCommand?: string;
  onInitialCommandConsumed?: () => void;
  initialNotice?: string;
  onInitialNoticeConsumed?: () => void;
  onTerminalFocus?: () => void;
  ctrlArmed?: boolean;
  onConsumeCtrl?: () => void;
}

export interface TerminalCoreInstanceHandle {
  focus: () => void;
  clearScreen: () => void;
  clearInput: () => void;
  blur: () => void;
  markForKill: () => void;
  /** Local injection — never reaches the shell. Used for initialNotice. */
  write: (data: string) => void;
  /** The current selection, celeritty's own text-mode buffer copy — there is
   *  no DOM selection to read (the terminal draws to a WebGPU canvas). */
  getSelection: () => string | null;
  /** Sends text to the PTY, as if typed — unlike `write`, this reaches the shell. */
  paste: (text: string) => void;
}

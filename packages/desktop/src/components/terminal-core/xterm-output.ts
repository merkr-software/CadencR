import type { IDisposable, IFunctionIdentifier, Terminal } from "@xterm/xterm";

// Built-in sequences that can synchronously send data while xterm parses output.
// Include mode setting: enabling focus reports can immediately report focus.
const REPLY_CSI: IFunctionIdentifier[] = [
  { final: "c" },
  { prefix: ">", final: "c" },
  { final: "n" },
  { prefix: "?", final: "n" },
  { intermediates: "$", final: "p" },
  { prefix: "?", intermediates: "$", final: "p" },
  { final: "t" },
  { prefix: "?", final: "h" },
];

/** Apply replay policy at parse time without muting keyboard/paste events. */
export class XtermOutput {
  private queuedReplyPolicy = true;
  private parsingReplyPolicy = true;
  private suppressParserData = false;
  private readonly hooks: IDisposable[];
  private readonly resetSuppression = (): void => {
    this.suppressParserData = false;
  };

  constructor(private readonly term: Terminal) {
    const guard = (): boolean => {
      if (!this.parsingReplyPolicy && !this.suppressParserData) {
        this.suppressParserData = true;
        // Built-in handlers run synchronously after this hook returns false.
        // Clear before the next browser event, even if parsing yields a frame.
        queueMicrotask(this.resetSuppression);
      }
      // Preserve rendering, mode changes and color settings in mixed set/query OSCs.
      return false;
    };
    this.hooks = [
      ...REPLY_CSI.map((id) => term.parser.registerCsiHandler(id, guard)),
      ...[4, 10, 11, 12].map((id) => term.parser.registerOscHandler(id, guard)),
      term.parser.registerDcsHandler({ intermediates: "$", final: "q" }, guard),
    ];
  }

  get forwardData(): boolean {
    return !this.suppressParserData;
  }

  write(data: string | Uint8Array, replyToQueries: boolean): void {
    if (replyToQueries !== this.queuedReplyPolicy) {
      // An empty write is a parser-ordered barrier. Changing policy at feed time
      // would apply a later live chunk's policy to still-queued replay output.
      this.term.write("", () => {
        this.parsingReplyPolicy = replyToQueries;
      });
      this.queuedReplyPolicy = replyToQueries;
    }
    if (replyToQueries) this.term.write(data);
    // Release suppression before a later live write is parsed in the same task.
    else this.term.write(data, this.resetSuppression);
  }

  dispose(): void {
    for (const hook of this.hooks) hook.dispose();
  }
}
